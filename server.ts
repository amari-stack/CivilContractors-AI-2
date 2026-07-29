import "dotenv/config";

import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";

// --------------------------------------------------
// Basic setup
// --------------------------------------------------

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const currentDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url || "file://"));
const distPath = path.resolve(process.cwd(), "dist");

app.use(express.static(distPath));

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// --------------------------------------------------
// Security and CORS
// --------------------------------------------------

const allowedOrigins = process.env.CLIENT_URL
  ? [process.env.CLIENT_URL]
  : [];

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // Disabled for Vite dev server compatibility
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests without origin (mobile apps, curl, direct visits) or during development
      if (!origin || process.env.NODE_ENV !== "production") {
        callback(null, true);
        return;
      }
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, true);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const proposalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many form submissions were made. Please wait and try again.",
  },
});

// --------------------------------------------------
// MongoDB setup & Fail-fast configuration
// --------------------------------------------------

mongoose.set("bufferCommands", false); // Do not hang on commands if DB is offline

interface ProposalDocument {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  service?: string;
  scale?: string;
  notes?: string;
  message?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const proposalSchema = new mongoose.Schema<ProposalDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 150 },
    phone: { type: String, trim: true, maxlength: 30 },
    company: { type: String, trim: true, maxlength: 150 },
    service: { type: String, trim: true, maxlength: 150 },
    scale: { type: String, trim: true, maxlength: 150 },
    notes: { type: String, trim: true, maxlength: 3000 },
    message: { type: String, trim: true, maxlength: 3000 },
  },
  {
    timestamps: true,
    collection: "proposals",
  }
);

const Proposal =
  mongoose.models.Proposal ||
  mongoose.model<ProposalDocument>("Proposal", proposalSchema);

let isMongoConnected = false;
const mongoUri = process.env.MONGODB_URI || process.env.MONGODB_URL;

if (mongoUri) {
  mongoose
    .connect(mongoUri)
    .then(() => {
      isMongoConnected = true;
      console.log("Connected to MongoDB Atlas.");
    })
    .catch((err) => {
      console.warn("MongoDB connection could not be established:", err.message);
    });
} else {
  console.warn("MongoDB URI not supplied. Operating with in-memory proposal fallback.");
}

// In-memory array for offline/fallback storage
const inMemoryProposals: Array<ProposalDocument & { _id: string; createdAt: Date }> = [];

// --------------------------------------------------
// Gemini API Lazy Initialization
// --------------------------------------------------

let aiClient: GoogleGenAI | null = null;
const getGeminiClient = () => {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not defined.");
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
};

// --------------------------------------------------
// API Routes
// --------------------------------------------------

app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "LA Contractors API is running.",
    database: isMongoConnected && mongoose.connection.readyState === 1 ? "connected" : "offline_fallback",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Welcome to the LA Contractors API.",
  });
});

// Proposal Submission Endpoint
app.post("/api/proposal", proposalLimiter, async (req: Request, res: Response) => {
  try {
    const { name, email, phone, company, service, scale, notes, message } = req.body as Partial<ProposalDocument>;

    if (!name || typeof name !== "string" || !name.trim() ||
        !email || typeof email !== "string" || !email.trim()) {
      res.status(400).json({
        success: false,
        message: "Name and email are required.",
      });
      return;
    }

    const ticketId = `LA-${Math.floor(10000 + Math.random() * 90000)}`;

    const proposalData: ProposalDocument & { _id: string; createdAt: Date } = {
      _id: ticketId,
      name: name.trim(),
      email: email.trim(),
      phone: typeof phone === "string" ? phone.trim() : undefined,
      company: typeof company === "string" ? company.trim() : undefined,
      service: typeof service === "string" ? service.trim() : undefined,
      scale: typeof scale === "string" ? scale.trim() : undefined,
      notes: typeof notes === "string" ? notes.trim() : undefined,
      message: typeof message === "string" ? message.trim() : undefined,
      createdAt: new Date(),
    };

    if (isMongoConnected && mongoose.connection.readyState === 1) {
      try {
        const doc = await Proposal.create(proposalData);
        res.status(201).json({
          success: true,
          message: "Your proposal was submitted successfully.",
          proposalId: doc._id ? doc._id.toString() : ticketId,
        });
        return;
      } catch (err) {
        console.warn("Mongoose create failed, falling back to in-memory:", err);
      }
    }

    // Fallback: Store in-memory
    inMemoryProposals.push(proposalData);
    res.status(201).json({
      success: true,
      message: "Your proposal was registered successfully.",
      proposalId: ticketId,
      fallback: true,
    });
  } catch (error) {
    console.error("Proposal submission error:", error);
    res.status(500).json({
      success: false,
      message: "Your proposal could not be submitted. Please try again.",
    });
  }
});

app.get("/api/proposal", async (_req: Request, res: Response) => {
  if (isMongoConnected && mongoose.connection.readyState === 1) {
    try {
      const docs = await Proposal.find().sort({ createdAt: -1 });
      res.status(200).json({ success: true, count: docs.length, data: docs });
      return;
    } catch {
      // Fallback below
    }
  }
  res.status(200).json({ success: true, count: inMemoryProposals.length, data: inMemoryProposals });
});

// Gemini Content Generation Endpoint
app.post("/api/gemini/generate", async (req: Request, res: Response) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({
        error: "Validation Error",
        message: "Prompt string is required in request body.",
      });
      return;
    }

    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    res.status(200).json({
      success: true,
      result: response.text,
    });
  } catch (error: any) {
    if (error.message && error.message.includes("GEMINI_API_KEY")) {
      res.status(500).json({
        error: "Gemini Configuration Error",
        message: "GEMINI_API_KEY is not configured in environment variables.",
      });
      return;
    }
    console.error("Gemini generation error:", error);
    res.status(500).json({
      error: "AI Generation Error",
      message: error.message || "Failed to generate AI content.",
    });
  }
});

// --------------------------------------------------
// Vite Middleware / Static Serving
// --------------------------------------------------

async function startServer(): Promise<void> {
  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGODB_URL;

  if (!mongoUri) {
    throw new Error(
      "MongoDB is not configured. Add MONGODB_URI in Render."
    );
  }

  await mongoose.connect(mongoUri);

  console.log("Connected to MongoDB.");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on port ${PORT}.`);
  });
}

startServer().catch((error: unknown) => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
