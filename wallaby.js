module.exports = function (wallaby) {
  return {
    files: ["cc.js"],
    tests: ["cc.spec.js"],
    env: {
      type: "node",
    },
  };
};
