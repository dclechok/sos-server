const router = require("express").Router();

router.use("/auth", require("./authRoutes"));
router.use("/accounts", require("./accountRoutes"));
router.use("/characters", require("./characterRoutes"));
router.use("/inventory", require("./inventoryRoutes"));
router.use("/map", require("./mapRoutes"));
router.use("/world", require("./worldObjectsRoutes"));
router.use("/defs", require("./defsRoutes"));

module.exports = router;