const express = require("express");
const router = express.Router();
const {
  getCharactersForAccount,
  createCharacterForAccount,
  deleteCharacterForAccount,
} = require("../controllers/characterController");
const auth = require("../middleware/auth");

// list
router.get("/:id", auth, getCharactersForAccount);

// create (for account)
router.post("/:id", auth, createCharacterForAccount);

// delete (character under account)
router.delete("/:accountId/:charId", auth, deleteCharacterForAccount);

module.exports = router;