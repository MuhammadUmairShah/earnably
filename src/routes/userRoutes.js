import express from "express";
import {
  getProfile,
  updateProfile,
  changePassword,
} from "../controllers/userController.js";

import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/profile", protect, getProfile);
router.patch("/profile", protect, updateProfile);
router.post("/change-password", protect, changePassword);

export default router;