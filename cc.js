const inspect = (name, value) => {
  console.log(name, value);
  return value;
};

const trace = (name, func) => (...args) => {
  console.log(`${name}(${args.join(`, `)})`);
  const value = func(...args);
  console.log(`${name} -> ${value}`);
  return value;
};

// Coins locked with this puzzle are spendable ccs.
//
// Choose a list of n inputs (n>=1), I_1, ... I_n with amounts A_1, ... A_n.
//
// We put them in a ring, so "previous" and "next" have intuitive k-1 and k+1 semantics,
// wrapping so {n} and 0 are the same, ie. all indices are mod n.
//
// Each coin creates 0 or more coins with total output value O_k.
// Let D_k = the "debt" O_k - A_k contribution of coin I_k, ie. how much debt this input accumulates.
// Some coins may spend more than they contribute and some may spend less, ie. D_k need
// not be zero. That's okay. It's enough for the total of all D_k in the ring to be 0.
//
// A coin can calculate its own D_k since it can verify A_k (it's hashed into the coin id)
// and it can sum up `CREATE_COIN` conditions for O_k.
//
// Defines a "subtotal of debts" S_k for each coin as follows:
//
// S_1 = 0
// S_k = S_{k-1} + D_{k-1}
//
// Here's the main trick that shows the ring sums to 0.
// You can prove by induction that S_{k+1} = D_1 + D_2 + ... + D_k.
// But it's a ring, so S_{n+1} is also S_1, which is 0. So D_1 + D_2 + ... + D_k = 0.
// So the total debts must be 0, ie. no coins are created or destroyed.
//
// Each coin's solution includes I_{k-1}, I_k, and I_{k+1} along with proofs that each is a CC.
// Each coin's solution includes S_{k-1}. It calculates D_k = O_k - A_k, and then S_k = S_{k-1} + D_{k-1}
//
// Announcements are used to ensure that each S_k follows the pattern is valid.
// Announcements automatically commit to their own coin id.
// Coin I_k creates an announcement that further commits to I_{k-1} and S_{k-1}.
//
// Coin I_k gets a proof that I_{k+1} is a CC, so it knows it must also create an announcement
// when spent. It checks that I_{k+1} creates an announcement committing to I_k and S_k.
//
// So S_{k+1} is correct iff S_k is correct.
//
// Coins also receive proofs that their neighbors are ccs, ensuring the announcements aren't forgeries, as
// inner puzzles are not allowed to use `CREATE_ANNOUNCEMENT`.
//
// In summary, I_k generates an announcement Y_k (for "yell") as follows:
//
//  Y_k: hash of I_k (automatically), I_{k-1}, S_k
//
// Each coin ensures that the next coin's announcement is as expected:
//  Y_{k+1} : hash of I_{k+1}, I_k, S_{k+1}
//
// TLDR:
//  I_k : coins
//  A_k : amount coin k contributes
//  O_k : amount coin k spend
//  D_k : difference/delta that coin k incurs (A - O)
//  S_k : subtotal of debts D_1 + D_2 ... + D_k
//  Y_k : announcements created by coin k commiting to I_{k-1}, I_k, S_k
//
// All conditions go through a "transformer" that looks for CREATE_COIN conditions
// generated by the inner solution, and wraps the puzzle hash ensuring the output is a cc.
//
// Three output conditions are prepended to the list of conditions for each I_k:
//  (ASSERT_MY_ID I_k) to ensure that the passed in value for I_k is correct
//  (CREATE_ANNOUNCEMENT I_{k-1} S_k) to create this coin's announcement
//  (ASSERT_ANNOUNCEMENT hashed_announcement(Y_{k+1})) to ensure the next coin really is next and
//     the relative values of S_k and S_{k+1} are correct
//
// This is all we need to do to ensure ccs exactly balance in the inputs and outputs.
//
// Proof:
//   Consider n, k, I_k values, O_k values, S_k and A_k as above.
//   For the (CREATE_ANNOUNCEMENT Y_{k+1}) (created by the next coin)
//   and (ASSERT_ANNOUNCEMENT hashed(Y_{k+1})) to match,
//   we see that I_k can ensure that is has the correct value for S_{k+1}.
//
//   By induction, we see that S_{m+1} = sum(i, 1, m) [O_i - A_i] = sum(i, 1, m) O_i - sum(i, 1, m) A_i
//   So S_{n+1} = sum(i, 1, n) O_i - sum(i, 1, n) A_i. But S_{n+1} is actually S_1 = 0,
//   so thus sum(i, 1, n) O_i = sum (i, 1, n) A_i, ie. output total equals input total.
//
// QUESTION: do we want a secondary puzzle that allows for coins to be spent? This could be good for
//  bleaching coins (sendable to any address), or reclaiming them by a central authority.
//

// GLOSSARY:
//  mod-hash: this code's sha256 tree hash
//  genesis-coin-checker: the function that determines if a coin can mint new ccs
//  inner-puzzle: an independent puzzle protecting the coins. Solutions to this puzzle are expected to
//              generate `AGG_SIG` conditions and possibly `CREATE_COIN` conditions.
// ---- items above are curried into the puzzle hash ----
//  inner-puzzle-solution: the solution to the inner puzzle
//  prev-coin-bundle: the bundle for previous coin
//  this-coin-bundle: the bundle for this coin
//  next-coin-bundle: the bundle for next coin
//  prev-subtotal: the subtotal between prev-coin and this-coin
//
// coin-info: `(parent_id puzzle_hash amount)`. This defines the coin id used with ASSERT_MY_COIN_ID
// coin-bundle: the cons box `(coin-info . lineage_proof)`
//
// and automatically hashed in to the announcement generated with CREATE_ANNOUNCEMENT.
//

const crypto = require("crypto");

const AGG_SIG = 49;
const AGG_SIG_ME = 50;

const CREATE_COIN = 51;
const CREATE_ANNOUNCEMENT = 52;

const ASSERT_ANNOUNCEMENT = 53;
const ASSERT_MY_COIN_ID = 54;

const ASSERT_SECONDS_AGE_EXCEEDS = 55;
const ASSERT_SECONDS_NOW_EXCEEDS = 56;

const ASSERT_HEIGHT_AGE_EXCEEDS = 57;
const ASSERT_HEIGHT_NOW_EXCEEDS = 58;

const RESERVE_FEE = 59;

////// start library code

const cons = (first, rest) => [first, rest];

const first = (cons) => cons[0];

const rest = (cons) => cons[1];

const list = (first, ...rest) =>
  cons(first, rest.length === 0 ? null : list(...rest));

const isList = Array.isArray;

const sha256 = (...args) =>
  crypto.createHash(`sha256`).update(args.join(``)).digest(`hex`);

const throwException = () => {
  throw new Error();
};

const assert = (first, ...rest) =>
  rest.length === 0 ? first : first ? assert(...rest) : throwException();

// curry(sum, 50, 60) => returns a function that is like sum(50, 60, ...)
// David: The JavaScript translation is probably wrong.
const curry = (func, listOfArgs) => cons(`a`, cons(func, listOfArgs));

const isInList = (atom, items) =>
  // returns 1 iff `atom` is in the list of `items`
  items ? (atom === first(items) ? 1 : isInList(atom, rest(items))) : 0;

// hash a tree with escape values representing already-hashed subtrees
// This optimization can be useful if you know the puzzle hash of a sub-expression.
// You probably actually want to use `curryAndHash` though.
const sha256TreeEsc = (tree, literals) =>
  isList(tree)
    ? sha256(
        2,
        sha256TreeEsc(first(tree), literals),
        sha256TreeEsc(rest(tree), literals)
      )
    : isInList(tree, literals)
    ? tree
    : sha256(1, tree);

// takes a lisp tree and returns the hash of it
const sha256Tree1 = (tree) =>
  isList(tree)
    ? sha256(2, sha256Tree1(first(tree)), sha256Tree1(rest(tree)))
    : sha256(1, tree);

// given a coin triplet, return the id of the coin
const coinIdForCoin = ([parentId, [puzzleHash, amount]]) =>
  sha256(parentId, puzzleHash, amount);

// utility to fetch coin amount from coin
const inputAmountForCoin = (coin) => first(rest(rest(coin)));

////// end library code

const ColoredCoin = (
  modHash, // curried into puzzle
  genesisCoinChecker, // curried into puzzle
  innerPuzzle, // curried into puzzle
  innerPuzzleSolution, // if invalid, inner-puzzle will fail
  prevCoinBundle, // used in this coin's announcement, prev-coin ASSERT_ANNOUNCEMENT will fail if wrong
  thisCoinBundle, // verified with ASSERT_MY_COIN_ID
  nextCoinBundle, // used to generate ASSERT_ANNOUNCEMENT
  prevSubtotal // included in announcement, prev-coin ASSERT_ANNOUNCEMENT will fail if wrong
) => {
  // return the puzzle hash for a cc with the given `genesisCoinCheckerHash` &
  // `innerPuzzle`
  const ccPuzzleHash = (
    [modHash, [modHashHash, [genesisCoinChecker, [genesisCoinCheckerHash]]]],
    innerPuzzleHash
  ) =>
    sha256TreeEsc(
      curry(modHash, modHashHash, genesisCoinCheckerHash, innerPuzzleHash),
      list(modHash, modHashHash, genesisCoinCheckerHash, innerPuzzleHash)
    );

  // tweak `CREATE_COIN` condition by wrapping the puzzle hash, forcing it to be a
  // cc prohibit CREATE_ANNOUNCEMENT
  const morphCondition = (condition, lineageProofParameters) =>
    first(condition) === CREATE_COIN
      ? list(
          CREATE_COIN,
          ccPuzzleHash(lineageProofParameters, first(rest(condition))),
          first(rest(rest(condition)))
        )
      : first(condition) === CREATE_ANNOUNCEMENT
      ? throwException()
      : condition;

  // tweak all `CREATE_COIN` conditions, enforcing created coins to be ccs
  const morphConditions = (conditions, lineageProofParameters) =>
    conditions
      ? cons(
          morphCondition(first(conditions), lineageProofParameters),
          morphConditions(rest(conditions), lineageProofParameters)
        )
      : null;

  // calculate the hash of an announcement
  const calculateAnnouncementId = (thisCoinInfo, thisSubtotal, nextCoinInfo) =>
    // NOTE: the next line containts a bug, as sha256Tree1 ignores `this-subtotal`
    sha256(
      coinIdForCoin(nextCoinInfo),
      sha256Tree1(list(thisCoinInfo, thisSubtotal))
    );

  // create the `ASSERT_ANNOUNCEMENT` condition that ensures the next coin's
  // announcement is correct
  const createAssertNextAnnouncementCondition = (
    thisCoinInfo,
    thisSubtotal,
    nextCoinInfo
  ) =>
    list(
      ASSERT_ANNOUNCEMENT,
      calculateAnnouncementId(thisCoinInfo, thisSubtotal, nextCoinInfo)
    );

  // here we commit to I_{k-1} and S_k
  const createAnnouncementCondition = (prevCoinInfo, prevSubtotal) =>
    list(CREATE_ANNOUNCEMENT, sha256Tree1(list(prevCoinInfo, prevSubtotal)));

  ///////////////////////////

  // this function takes a condition and returns an integer indicating
  // the value of all output coins created with CREATE_COIN. If it's not
  // a CREATE_COIN condition, it returns 0.

  const outputValueForCondition = (condition) =>
    first(condition) === CREATE_COIN ? first(rest(rest(condition))) : 0;

  // this function takes a list of conditions and returns an integer indicating
  // the value of all output coins created with CREATE_COIN

  const outputTotals = (conditions) =>
    conditions
      ? outputValueForCondition(first(conditions)) +
        outputTotals(rest(conditions))
      : 0;

  // ensure `thisCoinInfo` is correct by creating the `ASSERT_MY_COIN_ID`
  // condition
  const createAssertMyId = (thisCoinInfo) =>
    list(ASSERT_MY_COIN_ID, coinIdForCoin(thisCoinInfo));

  // add three conditions to the list of morphed conditions:
  // ASSERT_MY_COIN_ID for `this-coin-info`
  // CREATE_ANNOUNCEMENT for my announcement
  // ASSERT_ANNOUNCEMENT for the next coin's announcement
  const generateFinalOutputConditions = (
    prevSubtotal,
    thisSubtotal,
    morphedConditions,
    prevCoinInfo,
    thisCoinInfo,
    nextCoinInfo
  ) =>
    cons(
      createAssertMyId(thisCoinInfo),
      cons(
        createAnnouncementCondition(prevCoinInfo, prevSubtotal),
        cons(
          createAssertNextAnnouncementCondition(
            thisCoinInfo,
            thisSubtotal,
            nextCoinInfo
          ),
          morphedConditions
        )
      )
    );

  const coinInfoForCoinBundle = first;

  /////////////////////////// lineage checking

  // return true iff parent of `thisCoinInfo` is provably a cc
  const isParentCC = (
    lineageProofParameters,
    thisCoinInfo,
    [parentParentCoinId, [parentInnerPuzzleHash, [parentAmount]]]
  ) =>
    first(thisCoinInfo) ===
    sha256(
      parentParentCoinId,
      ccPuzzleHash(lineageProofParameters, parentInnerPuzzleHash),
      parentAmount
    );

  // return true iff the lineage proof is valid
  // lineageProof is of one of two forms:
  //  cons(1, (parentParentCoinId parentInnerPuzzleHash parentAmount))
  //  cons(0, someOpaqueProofPassedToGenesisCoinChecker)
  // so the `f` value determines what kind of proof it is, and the `r` value is the proof

  const genesisCoinCheckerForLpp = ([
    modHash,
    [modHashHash, [genesisCoinChecker, [genesisCoinCheckerHash]]],
  ]) => genesisCoinChecker;

  const isLineageProofValid = (
    lineageProofParameters,
    coinInfo,
    lineageProof
  ) =>
    first(lineageProof)
      ? isParentCC(
          lineageProofParameters,
          coinInfo,
          rest(lineageProofParameters)
        )
      : genesisCoinCheckerForLpp(lineageProofParameters)(
          list(lineageProofParameters, coinInfo, rest(lineageProof))
        );

  const isBundleValid = ([coin, lineageProof], lineageProofParameters) =>
    isLineageProofValid(lineageProofParameters, coin, lineageProof);

  ///////////////////////////

  const main = (
    lineageProofParameters,
    innerConditions,
    prevCoinBundle,
    thisCoinBundle,
    nextCoinBundle,
    prevSubtotal
  ) =>
    assert(
      // ensure prev is a cc (is this really necessary?)
      isBundleValid(prevCoinBundle, lineageProofParameters),

      // ensure this is a cc (to ensure parent wasn't counterfeit)
      isBundleValid(thisCoinBundle, lineageProofParameters),

      // ensure next is a cc (to ensure its announcements can be trusted)
      isBundleValid(nextCoinBundle, lineageProofParameters),

      generateFinalOutputConditions(
        prevSubtotal,

        // the expression on the next line calculates `this-subtotal` by adding the delta to `prev-subtotal`
        prevSubtotal +
          (inputAmountForCoin(coinInfoForCoinBundle(thisCoinBundle)) -
            outputTotals(innerConditions)),

        morphConditions(innerConditions, lineageProofParameters),
        coinInfoForCoinBundle(prevCoinBundle),
        coinInfoForCoinBundle(thisCoinBundle),
        coinInfoForCoinBundle(nextCoinBundle)
      )
    );

  return main(
    // cache some stuff: output conditions, and lineageProofParameters
    list(
      modHash,
      sha256Tree1(modHash),
      genesisCoinChecker,
      sha256Tree1(genesisCoinChecker)
    ),
    innerPuzzle(innerPuzzleSolution),
    prevCoinBundle,
    thisCoinBundle,
    nextCoinBundle,
    prevSubtotal
  );
};

module.exports = {
  AGG_SIG,
  CREATE_COIN,
  coinIdForCoin,
  ColoredCoin,
  cons,
  list,
  sha256,
  throwException,
};
