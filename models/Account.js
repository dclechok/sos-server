const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");

function Accounts() {
  return getDB().collection("accounts");
}

async function findById(id) {
  return Accounts().findOne(
    { _id: new ObjectId(id) },
    { projection: { passwordHash: 0 } }
  );
}

async function findByUsername(username) {
  return Accounts().findOne({
    username: { $regex: new RegExp(`^${username.trim()}$`, "i") }
  });
}

async function createAccount(data) {
  return Accounts().insertOne(data);
}

module.exports = {
  Accounts,
  findById,
  findByUsername,
  createAccount,
};
