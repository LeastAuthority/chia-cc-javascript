const assert = require(`assert`);
const crypto = require("crypto");
const { inspect } = require(`util`);

const {
  AGG_SIG,
  CREATE_COIN,
  ColoredCoin,
  cons,
  list,
  sha256,
  throwException,
} = require(`./cc`);

const Coin = (parentId, puzzleHash, amount) =>
  cons(parentId, cons(puzzleHash, amount));

const spendCoin = (coindId, puzzle, solution, signature) => [];

// from "An Introduction to developing in Chialisp"
// https://www.youtube.com/watch?v=dEFLJSU87K8
const PasswordProtectedCoin = ([password, [newPuzzleHash, [amount]]]) =>
  sha256(password) ===
  `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`
    ? list(list(CREATE_COIN, newPuzzleHash, amount))
    : throwException(`wrong password`);

it(`foo`, () => {
  //  modHash: this code's sha256 tree hash
  // The contract is expecting this to be a function to be curried?
  const modHash = sha256(`mod`);

  //  genesisCoinChecker: the function that determines if a coin can mint new ccs
  const genesisCoinChecker = () => true;

  //  innerPuzzle: an independent puzzle protecting the coins. Solutions to this puzzle are expected to
  //              generate `AGG_SIG` conditions and possibly `CREATE_COIN` conditions.
  const innerPuzzle = PasswordProtectedCoin;

  const newPuzzleHash = `cafef00d`;
  const innerPuzzleSolution = list(`hello`, newPuzzleHash, 200);

  const amount = 1;
  const coinInfo = Coin(`parentId`, `puzzleHash`, amount);

  //  cons(1, (parentParentCoinId parentInnerPuzzleHash parentAmount))
  //  cons(0, someOpaqueProofPassedToGenesisCoinChecker)
  const lineageProof = cons(0, `someOpaqueProofPassedToGenesisCoinChecker`);

  const prevCoinBundle = cons(coinInfo, lineageProof);
  const thisCoinBundle = cons(coinInfo, lineageProof);
  const nextCoinBundle = cons(coinInfo, lineageProof);

  const prevSubtotal = 0;

  const conditions = ColoredCoin(
    modHash,
    genesisCoinChecker,
    innerPuzzle,
    innerPuzzleSolution,
    prevCoinBundle,
    thisCoinBundle,
    nextCoinBundle,
    prevSubtotal
  );

  console.log(inspect(conditions, { depth: null }));
  assert(false);
});
