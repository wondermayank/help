import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Set up larger JSON limit to support image scans (photos of product ingredients labels)
app.use(express.json({ limit: "15mb" }));

// Lazy initializer for Gemini client
let geminiClient: GoogleGenAI | null = null;

function getGeminiClient() {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not configured. Please supply your API key in the Secrets panel in AI Studio Settings.");
    }
    geminiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return geminiClient;
}

// 1. API: Build personalized skincare routine
app.post("/api/analyze-routine", async (req, res) => {
  try {
    const { skinType, concerns, sensitivity, environment, ageRange, budgetRange, extraDetails } = req.body;

    const googleAi = getGeminiClient();

    const systemPrompt = `You are an elite, honest dermatologist and holistic skincare formulation expert.
Your goal is to build a customized morning and evening skincare ritual based on the user's details.
Provide highly practical steps, focus on gentle active ingredients, advise against marketing traps, and warn about mixing incompatible products.
Always prioritize skin barrier health.`;

    const prompt = `Create a personalized skincare routine for:
- Skin Type: ${skinType || "Normal/Unspecified"}
- Core Concerns: ${concerns ? concerns.join(", ") : "General maintenance"}
- Sensitivity Level: ${sensitivity || "Medium"}
- Climate & Environment: ${environment || "Moderate/Temperate"}
- Age Range: ${ageRange || "Unspecified"}
- Budget Pref: ${budgetRange || "Standard"}
- Extra Details: ${extraDetails || "None"}

Please output the routine in a highly structured, valid JSON object fitting the requested schema. Ensure steps are chronological, products chosen fit their skin concerns, active ingredient interaction safety tips are included, and direct, honest dermatologist feedback on their profile is provided.`;

    const response = await googleAi.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["skinAnalysis", "morningRoutine", "eveningRoutine", "honestDermatologistCautions", "recommendedActiveSpotlights"],
          properties: {
            skinAnalysis: {
              type: Type.OBJECT,
              required: ["skinTypeSummary", "generalBarrierCondition", "keyShortTermFoci"],
              properties: {
                skinTypeSummary: { type: Type.STRING },
                generalBarrierCondition: { type: Type.STRING },
                keyShortTermFoci: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                }
              }
            },
            morningRoutine: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["step", "name", "category", "activeIngredients", "productTypes", "purpose", "applicationTip", "isOptional"],
                properties: {
                  step: { type: Type.INTEGER },
                  name: { type: Type.STRING },
                  category: { type: Type.STRING, description: "e.g., Cleanser, Toner, Serum, Moisturizer, Sunscreen" },
                  activeIngredients: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  },
                  productTypes: { type: Type.STRING, description: "Recommended texture or form, e.g. Creamy low-pH wash, 10% L-Ascorbic Acid Serum" },
                  purpose: { type: Type.STRING },
                  applicationTip: { type: Type.STRING },
                  isOptional: { type: Type.BOOLEAN }
                }
              }
            },
            eveningRoutine: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["step", "name", "category", "activeIngredients", "productTypes", "purpose", "applicationTip", "isOptional"],
                properties: {
                  step: { type: Type.INTEGER },
                  name: { type: Type.STRING },
                  category: { type: Type.STRING, description: "e.g., Oil Cleanser, Foaming Cleanser, Chemical Exfoliating Serum, Barrier Cream" },
                  activeIngredients: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  },
                  productTypes: { type: Type.STRING, description: "Recommended product type, e.g. Lightweight cleansing oil, 2% Salicylic Acid solution" },
                  purpose: { type: Type.STRING },
                  applicationTip: { type: Type.STRING },
                  isOptional: { type: Type.BOOLEAN }
                }
              }
            },
            honestDermatologistCautions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Direct warnings, e.g. Do not layer retinol with exfoliating acids. Purging warnings etc."
            },
            recommendedActiveSpotlights: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["ingredient", "role", "usageAdvice"],
                properties: {
                  ingredient: { type: Type.STRING },
                  role: { type: Type.STRING },
                  usageAdvice: { type: Type.STRING }
                }
              }
            }
          }
        }
      }
    });

    const resultText = response.text;
    if (!resultText) {
      throw new Error("Received empty response from the AI model.");
    }

    const parsedJson = JSON.parse(resultText.trim());
    return res.json(parsedJson);

  } catch (err: any) {
    console.error("Error in /api/analyze-routine:", err);
    return res.status(500).json({
      error: err.message || "An error occurred while custom designing your skincare routine."
    });
  }
});

// 2. API: Analyze skincare product ingredients list (via pasted list or image file)
app.post("/api/analyze-ingredients", async (req, res) => {
  try {
    const { ingredientsText, imageData, imageMime } = req.body;

    const googleAi = getGeminiClient();

    const systemPrompt = `You are a strict, objective, and brutally honest skincare cosmetic chemist.
You analyze cosmetic ingredient listings. Your task is to expose marketing fluff, verify if the concentrations of key actives are actually beneficial, flag drying alcohols, synthetic fragrances, essential oils, or heavy comedogenic (pore-clogging) waxes, and issue a direct safety rating. Keep in mind that ingredients are listed in descending order of concentration.`;

    let contentInput: any = "";
    if (imageData && imageMime) {
      // Analyze with image part (label snapshot)
      const imagePart = {
        inlineData: {
          mimeType: imageMime,
          data: imageData // base64 encoded string
        }
      };
      const textPart = {
        text: `Inspect this ingredient list label image. Extract all ingredient names if legible and perform a comprehensive, brutally honest cosmetic chemist breakdown. 
Please formulate a structured JSON output according to the requested schema. If there's additional feedback or the image is blurry, do your best to guess or extract what is visible.`
      };
      contentInput = { parts: [imagePart, textPart] };
    } else if (ingredientsText) {
      // Analyze pasted text
      contentInput = `Perform a comprehensive, brutally honest cosmetic chemist analysis of the following skincare ingredients:
"${ingredientsText}"

Please formulate a highly structured response in valid JSON matching the specified schema. Identify marketing filler, active percentage likelihoods, comedogenicity indexes, potential skin barriers disrupts, and list exact triggers.`;
    } else {
      return res.status(400).json({ error: "Missing ingredients text list or image data." });
    }

    const response = await googleAi.models.generateContent({
      model: "gemini-3.5-flash",
      contents: contentInput,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["productName", "ingredientsCount", "overallSafetyScore", "safetyTier", "poreCloggingRating", "keyActives", "harmfulOrIrritatingIngs", "honestVerdict", "suitableForTypes", "unsuitableForTypes"],
          properties: {
            productName: { type: Type.STRING, description: "Identified product name, brand, or general label designation. Default to Unknown if impossible to tell." },
            ingredientsCount: { type: Type.INTEGER },
            overallSafetyScore: { type: Type.INTEGER, description: "Rating from 0 to 100 on clean and safe formulations, where 100 is exceptionally gentle and barrier-respectful." },
            safetyTier: { type: Type.STRING, description: "Must be excellent, good, fair, or avoid." },
            poreCloggingRating: { type: Type.STRING, description: "Must be non-comedogenic, mildly comedogenic, highly comedogenic, or unknown" },
            keyActives: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["name", "benefit", "scientificEvidence"],
                properties: {
                  name: { type: Type.STRING },
                  benefit: { type: Type.STRING },
                  scientificEvidence: { type: Type.STRING, description: "Strong, medium, or weak" }
                }
              }
            },
            harmfulOrIrritatingIngs: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["name", "type", "issueDescription"],
                properties: {
                  name: { type: Type.STRING },
                  type: { type: Type.STRING, description: "e.g. Drying Alcohol, Synthetic Fragrance, Essential Oil, Drying Sulphate, Paraben, Harsh Preservative" },
                  issueDescription: { type: Type.STRING }
                }
              }
            },
            honestVerdict: { type: Type.STRING, description: "A witty, honest, no-nonsense dermatologist's verdict on whether this is a premium worthy formula or overpriced water." },
            suitableForTypes: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            unsuitableForTypes: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          }
        }
      }
    });

    const resultText = response.text;
    if (!resultText) {
      throw new Error("Received empty response from the ingredients analyzer.");
    }

    const parsedJson = JSON.parse(resultText.trim());
    return res.json(parsedJson);

  } catch (err: any) {
    console.error("Error in /api/analyze-ingredients:", err);
    return res.status(500).json({
      error: err.message || "An error occurred while analyzing the product ingredients list."
    });
  }
});

// 3. Integrate SPA client Vite logic or Serve static files
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Development Mode
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production Mode
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SkinCare Ritual] Server booted successfully! Listening on Port ${PORT}`);
  });
}

startServer();
