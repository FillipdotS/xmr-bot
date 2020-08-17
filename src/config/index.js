// Use "production" or "development"
const env = process.env.NODE_ENV;
console.log("Using " + "./config." + env);
const cfg = require("./config." + env);

module.exports = cfg;