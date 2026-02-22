const bcrypt = require("bcryptjs");
const { Accounts, findByUsername } = require("../models/Account");
const generateToken = require("../utils/token");

// ===========================
// REGISTER
// ===========================
exports.register = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const users = Accounts();
    const existing = await users.findOne({ $or: [{ email }, { username }] });

    if (existing) {
      return res.status(409).json({ message: "Username or email exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await users.insertOne({
      username,
      email,
      passwordHash,
      createdAt: new Date(),

      // ✅ defaults so fields are never missing
      role: "player",
      characters: [],
    });

    return res.json({
      user: {
        id: result.insertedId.toString(),
        username,
        email,
        role: "player",
        characters: [],
      },

      // keeping your existing call signature untouched
      token: generateToken(result.insertedId, username, email),
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// ===========================
// LOGIN
// ===========================
exports.login = async (req, res) => {
  try {
    const { username, unhashedPass } = req.body;

    if (!username || !unhashedPass) {
      return res.status(400).json({ message: "Username and password required" });
    }

    const user = await findByUsername(username);

    if (!user) {
      return res.status(401).json({ message: "Invalid username" });
    }

    const isMatch = await bcrypt.compare(unhashedPass, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid password" });
    }

    const token = generateToken(user);

    return res.json({
      user: {
        id: user._id.toString(),
        username: user.username,

        // ✅ include role
        role: user.role || "player",

        characters: user.characters || [],
      },
      token,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// ===========================
// ME (VERIFY TOKEN)
// ===========================
exports.me = async (req, res) => {
  try {
    const users = Accounts();

    const user = await users.findOne(
      { username: req.user.username },
      { projection: { passwordHash: 0 } }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        role: user.role || "player",
        characters: user.characters || [],
      },
    });
  } catch (err) {
    console.error("Me error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};