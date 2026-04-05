import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DAILY_SCAN_LIMIT = 2;

serve(async (req) => {
  console.log("scan-receipt function called");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("scan-receipt function called");
    const GOOGLE_AI_KEY = Deno.env.get("GOOGLE_AI_KEY");
    console.log(GOOGLE_AI_KEY ? "GOOGLE_AI_KEY is configured" : "GOOGLE_AI_KEY is NOT configured");
    if (!GOOGLE_AI_KEY) throw new Error("GOOGLE_AI_KEY is not configured");

    // Authenticate the user server-side
    const authHeader = req.headers.get("authorization");
    console.log("Auth header:", authHeader ? "present" : "missing");
    if (!authHeader) throw new Error("Not authenticated");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    console.log("Creating Supabase client...");
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    console.log("Getting user...");
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Not authenticated");
    console.log("User authenticated:", user.id);

    // Server-side scan limit enforcement
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    console.log("Checking scan limit...");
    const { count } = await supabase
      .from("receipts")
      .select("id", { count: "exact", head: true })
      .eq("created_by", user.id)
      .gte("created_at", today.toISOString());

    if ((count || 0) >= DAILY_SCAN_LIMIT) {
      return new Response(
        JSON.stringify({ error: `Daily scan limit reached (${DAILY_SCAN_LIMIT}/day). Use manual bill entry instead.` }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Parsing request body...");
    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) throw new Error("No image provided");

    const supportedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const resolvedMime = mimeType || "image/jpeg";
    if (!supportedTypes.includes(resolvedMime)) {
      return new Response(
        JSON.stringify({ error: "Unsupported file type. Please upload an image (JPEG, PNG, WebP, or GIF)." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Limit payload size (~10MB base64)
    if (imageBase64.length > 10 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: "Image too large. Please use a smaller image." }),
        { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Calling Google Gemini API...",imageBase64.length);
    const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_AI_KEY}`,{
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: resolvedMime,
                    data: imageBase64,
                  },
                },
                {
                  text: `Extract all items from this receipt. Return ONLY valid JSON, no markdown:
{
  "items": [{"name": "Item Name", "price": 12.99}],
  "tax": 1.50,
  "tip": 0,
  "total": 14.49,
  "currency": "$"
}`,
                },
              ],
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Google Gemini error:", response.status, errorText);

      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Gemini error: ${response.status}`);
    }

    const data = await response.json();
    console.log("Gemini response:", JSON.stringify(data).substring(0, 200));
    
    // Parse Gemini's response format
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log("Extracted text:", text);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Could not parse receipt data from AI response");
    
    const parsed = JSON.parse(jsonMatch[0]);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("scan-receipt error:", e);
    const errorMessage = e instanceof Error ? e.message : String(e);
    const errorStack = e instanceof Error ? e.stack : '';
    console.error("Error stack:", errorStack);
    return new Response(
      JSON.stringify({ error: errorMessage, details: errorStack }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
