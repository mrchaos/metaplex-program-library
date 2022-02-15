import test from 'tape';

import {
  Account,
  addressLabels,
  getAccount,
  initAndActivateVault,
  initVault,
  killStuckProcess,
  spokSameBignum,
  spokSamePubkey,
} from './utils';
import { Signer, Transaction } from '@solana/web3.js';
import {
  assertConfirmedTransaction,
  assertError,
  assertTransactionSummary,
  tokenBalanceFor,
  tokenBalancesOfTransaction,
} from '@metaplex-foundation/amman';
import { mintSharesToTreasury } from '../src/instructions/mint-shares-to-treasury';
import { MintFractionalSharesInstructionAccounts } from '../src/mpl-token-vault';
import spok, { Specifications } from 'spok';
import { bignum } from '@metaplex-foundation/beet';
import BN from 'bn.js';
import {
  createWithdrawDestinationAccount,
  withdrawSharesFromTreasury,
  WithdrawSharesFromTreasuryAccounts,
} from '../src/instructions/withdraw-shares-from-treasury';

killStuckProcess();

test('withdraw shares: active vault which minted sufficient shares, mint various sizes 0 - 5,000,000,000', async (t) => {
  // -----------------
  // Init and Activate Vault
  // -----------------
  const {
    transactionHandler,
    connection,
    accounts: initVaultAccounts,
  } = await initAndActivateVault(t, { allowFurtherShareCreation: true });
  const {
    payer,
    vault,
    authority: vaultAuthority,
    vaultAuthorityPair,
    fractionMint,
    fractionTreasury,
    fractionMintAuthority,
  } = initVaultAccounts;

  addressLabels.addLabels(initVaultAccounts);

  // -----------------
  // Mint Shares
  // -----------------
  const MINTED_SHARES = new BN('6000000000');
  {
    const accounts: MintFractionalSharesInstructionAccounts = {
      fractionTreasury,
      fractionMint,
      vault,
      vaultAuthority,
      mintAuthority: fractionMintAuthority,
    };
    const signers: Signer[] = [vaultAuthorityPair];
    const mintSharesIx = mintSharesToTreasury(accounts, MINTED_SHARES);

    const tx = new Transaction().add(mintSharesIx);
    const res = await transactionHandler.sendAndConfirmTransaction(tx, signers);
    assertConfirmedTransaction(t, res.txConfirmed);
  }

  // -----------------
  // Create Destination Account
  // -----------------
  const [createDestinationIxs, createDestinationSigners, { destination }] =
    await createWithdrawDestinationAccount(connection, { payer, fractionMint });
  {
    const tx = new Transaction().add(...createDestinationIxs);
    const res = await transactionHandler.sendAndConfirmTransaction(tx, createDestinationSigners);
    assertConfirmedTransaction(t, res.txConfirmed);
  }

  // -----------------
  // Withdraw Shares
  // -----------------
  const accounts: WithdrawSharesFromTreasuryAccounts = {
    fractionTreasury,
    destination,
    vault,
    vaultAuthority,
  };
  const signers: Signer[] = [vaultAuthorityPair];
  async function runAndVerify(numberOfShares: bignum, previousDelta: bignum) {
    t.comment(`++++++Withdrawing ${numberOfShares} shares`);
    const withdrawSharesIx = await withdrawSharesFromTreasury(accounts, numberOfShares);

    const tx = new Transaction().add(withdrawSharesIx);
    const res = await transactionHandler.sendAndConfirmTransaction(tx, signers);
    assertConfirmedTransaction(t, res.txConfirmed);

    console.log(await tokenBalancesOfTransaction(connection, res.txSignature));

    const expectedDestinationTotal = new BN(previousDelta).add(new BN(numberOfShares));
    const expectedTreasuryPreviousTotal = new BN(MINTED_SHARES).sub(new BN(previousDelta));
    const expectedTreasuryTotal = new BN(MINTED_SHARES).sub(expectedDestinationTotal);

    // -----------------
    // Destination Changes
    // -----------------
    const destinationTokenBalance = await tokenBalanceFor(connection, {
      sig: res.txSignature,
      mint: fractionMint,
      owner: payer,
    });
    spok(t, destinationTokenBalance, {
      $topic: 'tokenBalance destination',
      amountPre: spokSameBignum(previousDelta),
      amountPost: spokSameBignum(expectedDestinationTotal),
    });
    const destinationAccount = await getAccount(connection, destination);
    spok(t, destinationAccount, <Specifications<Partial<Account>>>{
      $topic: 'destinationAccount',
      address: spokSamePubkey(destination),
      mint: spokSamePubkey(fractionMint),
      owner: spokSamePubkey(payer),
      amount: spokSameBignum(expectedDestinationTotal),
    });

    // -----------------
    // Fraction Treasury Changes
    // -----------------
    const treasuryTokenBalance = await tokenBalanceFor(connection, {
      sig: res.txSignature,
      mint: fractionMint,
      owner: fractionMintAuthority,
    });
    spok(t, treasuryTokenBalance, {
      $topic: 'tokenBalance fractionTreasury',
      amountPre: spokSameBignum(expectedTreasuryPreviousTotal),
      amountPost: spokSameBignum(expectedTreasuryTotal),
    });

    const fractionTreasuryAccount = await getAccount(connection, fractionTreasury);
    spok(t, fractionTreasuryAccount, <Specifications<Partial<Account>>>{
      $topic: 'fractionTreasuryAccount',
      address: spokSamePubkey(fractionTreasury),
      mint: spokSamePubkey(fractionMint),
      owner: spokSamePubkey(fractionMintAuthority),
      amount: spokSameBignum(expectedTreasuryTotal),
    });
  }

  await runAndVerify(0, 0);
  await runAndVerify(5, 0);
  await runAndVerify(new BN('5000000000' /* 5,000,000,000 */), 5);
});