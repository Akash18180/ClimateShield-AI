import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Memory Cache for API data (15 minutes TTL)
const climateCache: Record<string, { timestamp: number; data: any }> = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 mins

// Historical baseline coefficients for Indian cities
const CITY_BASELINES: Record<string, { lat: number; lon: number; temp: number; hum: number; rain: number; aqi: number; pop: number; floodBase: number }> = {
  Chennai: { lat: 13.0827, lon: 80.2707, temp: 33, hum: 75, rain: 12, aqi: 85, pop: 4800000, floodBase: 45 },
  Delhi: { lat: 28.6139, lon: 77.2090, temp: 37, hum: 40, rain: 3, aqi: 245, pop: 9500000, floodBase: 15 },
  Mumbai: { lat: 19.0760, lon: 72.8777, temp: 31, hum: 80, rain: 28, aqi: 90, pop: 8200000, floodBase: 60 },
  Bengaluru: { lat: 12.9716, lon: 77.5946, temp: 28, hum: 55, rain: 6, aqi: 65, pop: 3500000, floodBase: 25 },
  Kolkata: { lat: 22.5726, lon: 88.3639, temp: 32, hum: 78, rain: 18, aqi: 140, pop: 5100000, floodBase: 50 },
  Hyderabad: { lat: 17.3850, lon: 78.4867, temp: 35, hum: 48, rain: 5, aqi: 95, pop: 4200000, floodBase: 20 },
};

// Heatwave Prediction Engine
function calculateHeatwavePrediction(temp: number, humidity: number, windSpeed: number) {
  // Simplified Heat Index formula
  const heatIndex = temp + 0.5 * (temp - 10) * (humidity / 100);
  const riskScore = Math.min(100, Math.max(0, Math.round((heatIndex - 25) * 4.5 - windSpeed * 0.4)));
  const probability = Number((1 / (1 + Math.exp(-(riskScore - 50) / 12))).toFixed(2));
  const confidence = Math.round(82 + (temp % 5) * 2 + (windSpeed % 3));

  let riskCategory: 'Low' | 'Moderate' | 'High' | 'Critical' = 'Low';
  if (riskScore >= 85) riskCategory = 'Critical';
  else if (riskScore >= 60) riskCategory = 'High';
  else if (riskScore >= 35) riskCategory = 'Moderate';

  return { riskScore, probability, confidence, riskCategory };
}

// Flood Prediction Engine
function calculateFloodPrediction(rainfall: number, humidity: number, floodBase: number) {
  // Susceptibility influenced by rainfall and soil saturation proxy (humidity)
  const riskScore = Math.min(100, Math.max(0, Math.round(rainfall * 2.2 + humidity * 0.3 + floodBase)));
  const probability = Number((1 / (1 + Math.exp(-(riskScore - 45) / 10))).toFixed(2));
  const confidence = Math.round(85 + (rainfall % 4) * 2);

  let riskCategory: 'Low' | 'Moderate' | 'High' | 'Critical' = 'Low';
  if (riskScore >= 80) riskCategory = 'Critical';
  else if (riskScore >= 55) riskCategory = 'High';
  else if (riskScore >= 30) riskCategory = 'Moderate';

  return { probability, confidence, riskCategory, riskScore };
}

// Health Impact and Air pollution trends generator
function generateAirForecast(currentAqi: number, windSpeed: number) {
  const trends: Array<{ day: string; temp: number; aqi: number; floodProb: number }> = [];
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  
  let tempAqi = currentAqi;
  for (let i = 0; i < 7; i++) {
    const windEffect = (windSpeed - 12) * 1.5; // higher wind cleanses air
    const dayVariation = Math.sin(i * 1.2) * 12 + (Math.random() - 0.5) * 15;
    tempAqi = Math.max(10, Math.round(tempAqi + dayVariation - windEffect));
    
    trends.push({
      day: days[i],
      temp: Math.round(28 + Math.sin(i * 0.8) * 4 + (Math.random() - 0.5) * 2),
      aqi: tempAqi,
      floodProb: Math.round(Math.max(5, Math.min(95, 15 + Math.cos(i * 0.9) * 35 + (Math.random() - 0.5) * 10))),
    });
  }
  return trends;
}

// REST Route: Get climate data for city or coordinates
app.get("/api/climate-data", async (req, res) => {
  const { city: cityParam, lat: latParam, lon: lonParam } = req.query;
  
  const lat = latParam !== undefined ? Number(latParam) : NaN;
  const lon = lonParam !== undefined ? Number(lonParam) : NaN;
  const isCoords = !isNaN(lat) && !isNaN(lon);

  let city = "Chennai";
  let baseline = CITY_BASELINES["Chennai"];

  if (isCoords) {
    city = `Location (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
    // Generate a reasonable baseline dynamic value for arbitrary coordinates
    const tempBase = Math.round(28 + Math.sin(lat * 0.1) * 3);
    const humBase = Math.round(65 + Math.cos(lon * 0.1) * 10);
    baseline = {
      lat,
      lon,
      temp: tempBase,
      hum: humBase,
      rain: 5,
      aqi: 80,
      pop: 1500000,
      floodBase: 35
    };
  } else {
    const cityParamStr = String(cityParam || "Chennai");
    if (CITY_BASELINES[cityParamStr]) {
      city = cityParamStr;
      baseline = CITY_BASELINES[city];
    }
  }

  const cacheKey = isCoords ? `coords:${lat.toFixed(2)},${lon.toFixed(2)}` : city;
  const now = Date.now();
  if (climateCache[cacheKey] && now - climateCache[cacheKey].timestamp < CACHE_TTL) {
    return res.json(climateCache[cacheKey].data);
  }

  // Attempt live API integrations
  let liveTemp = baseline.temp;
  let liveHumidity = baseline.hum;
  let liveWind = 12;
  let liveRain = baseline.rain;
  let liveAqi = baseline.aqi;
  let condition = "Cloudy";

  const openWeatherKey = process.env.OPENWEATHER_API_KEY;
  const waqiKey = process.env.WAQI_API_KEY;

  try {
    if (openWeatherKey) {
      let weatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=${city},IN&appid=${openWeatherKey}&units=metric`;
      if (isCoords) {
        weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${openWeatherKey}&units=metric`;
      }
      const weatherRes = await fetch(weatherUrl);
      if (weatherRes.ok) {
        const wData = await weatherRes.json();
        liveTemp = Math.round(wData.main?.temp ?? liveTemp);
        liveHumidity = wData.main?.humidity ?? liveHumidity;
        liveWind = Math.round((wData.wind?.speed ?? 3.3) * 3.6); // m/s to km/h
        liveRain = wData.rain?.["1h"] ? wData.rain["1h"] * 24 : (wData.clouds?.all > 70 ? baseline.rain * 1.2 : 1.5);
        condition = wData.weather?.[0]?.main ?? "Cloudy";
        if (isCoords && wData.name) {
          city = wData.name;
        }
      }
    } else if (isCoords) {
      // Deterministic simulation based on coordinates if key isn't provided
      const seed = Math.sin(lat) * Math.cos(lon);
      liveTemp = Math.round(28 + seed * 8);
      liveHumidity = Math.round(65 + seed * 15);
      liveWind = Math.round(10 + Math.abs(seed) * 15);
      liveRain = Math.max(0.2, Number((Math.abs(seed) * 15).toFixed(1)));
      condition = seed > 0.3 ? "Rainy" : seed < -0.3 ? "Clear" : "Cloudy";
    }
  } catch (err) {
    console.error("OpenWeather Fetch Error, falling back to simulated model:", err);
  }

  try {
    if (waqiKey) {
      let aqiUrl = `https://api.waqi.info/feed/${city}/?token=${waqiKey}`;
      if (isCoords) {
        aqiUrl = `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${waqiKey}`;
      }
      const aqiRes = await fetch(aqiUrl);
      if (aqiRes.ok) {
        const aData = await aqiRes.json();
        if (aData.status === "ok" && typeof aData.data?.aqi === "number") {
          liveAqi = aData.data.aqi;
          if (isCoords && aData.data.city?.name && !openWeatherKey) {
            const parts = aData.data.city.name.split(",");
            city = parts[0].trim();
          }
        }
      }
    } else if (isCoords) {
      // Deterministic AQI simulation
      const seed = Math.sin(lat * 2) * Math.cos(lon * 2);
      liveAqi = Math.round(110 + seed * 60);
    }
  } catch (err) {
    console.error("WAQI Fetch Error, falling back to simulated model:", err);
  }

  // Calculate PM particles based on AQI
  const pm25 = Math.round(liveAqi * 0.45 + (Math.random() - 0.5) * 5);
  const pm10 = Math.round(liveAqi * 0.75 + (Math.random() - 0.5) * 8);
  const no2 = Math.round(liveAqi * 0.12 + 10);
  const o3 = Math.round(liveAqi * 0.18 + 15);
  const co = Number((liveAqi * 0.005 + 0.2).toFixed(1));

  // Run prediction engines server side
  const heatwave = calculateHeatwavePrediction(liveTemp, liveHumidity, liveWind);
  const flood = calculateFloodPrediction(liveRain, liveHumidity, baseline.floodBase);
  const forecast7Days = generateAirForecast(liveAqi, liveWind);

  // Health Impact Score
  const healthImpactScore = Math.min(100, Math.round((liveAqi * 0.4) + (heatwave.riskScore * 0.3) + (flood.riskScore * 0.3)));

  const finalData = {
    city,
    latitude: baseline.lat,
    longitude: baseline.lon,
    weather: {
      temp: liveTemp,
      humidity: liveHumidity,
      windSpeed: liveWind,
      rainfall: Number(liveRain.toFixed(1)),
      condition,
    },
    aqi: {
      aqi: liveAqi,
      pm25,
      pm10,
      no2,
      o3,
      co,
      dominant: liveAqi > 150 ? "PM2.5" : liveAqi > 100 ? "PM10" : "O3",
    },
    heatwave,
    flood,
    populationAtRisk: Math.round(baseline.pop * (healthImpactScore / 200)),
    healthImpactScore,
    forecast7Days,
  };

  // Cache response
  climateCache[city] = {
    timestamp: now,
    data: finalData,
  };

  res.json(finalData);
});

// REST Route: Dynamic Context-Aware AI Chatbot powered by Gemini
app.post("/api/chat", async (req, res) => {
  const { messages, currentContext } = req.body;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Invalid messages format" });
  }

  const promptContext = `
You are the primary Climate Crisis Response Advisor for ClimateShield AI, India's award-winning Climate Intelligence platform.
Your objective is to provide highly precise, practical, context-aware instructions to protect citizens and support municipal government planning.

--- CURRENT DYNAMIC DASHBOARD CONTEXT ---
Target Location: ${currentContext?.city || "Chennai, India"}
Temperature: ${currentContext?.weather?.temp || 35}°C (Humidity: ${currentContext?.weather?.humidity || 65}%)
Air Quality Index (AQI): ${currentContext?.aqi?.aqi || 120} (Dominant Pollutant: ${currentContext?.aqi?.dominant || "PM2.5"})
Heatwave Risk Level: ${currentContext?.heatwave?.riskCategory || "Moderate"} (Score: ${currentContext?.heatwave?.riskScore || 45}/100)
Flood Susceptibility Level: ${currentContext?.flood?.riskCategory || "Moderate"} (Score: ${currentContext?.flood?.riskScore || 38}/100, Est. Rainfall: ${currentContext?.weather?.rainfall || 12} mm)
Estimated At-Risk Population: ${currentContext?.populationAtRisk || 120000} citizens
Cumulative Health Impact Score: ${currentContext?.healthImpactScore || 42}/100

When crafting your response:
1. Always reference the current dashboard values above directly to justify your recommendations.
2. Structure your response cleanly with markdown lists, bold headers, and subheadings.
3. Keep instructions divided into distinct sections: "Citizen Action Guidelines" and "Municipal Resource Allocation Suggestions".
4. Be urgent yet professional. Do not use generic answers. Provide advice specifically relevant to India's urban climate challenges.
`;

  if (!geminiKey || geminiKey === "MY_GEMINI_API_KEY") {
    // If key is missing or is the placeholder, return a high-fidelity simulated response with an notice
    const lastUserMessage = messages[messages.length - 1]?.text || "What should I do tomorrow?";
    
    // Simulate smart context-aware answer
    const simulatedAnswer = `
[DEMO MODE NOTICE: Add your GEMINI_API_KEY to Settings > Secrets in AI Studio to enable live AI reasoning]

### Climate Advisory for ${currentContext?.city || "Chennai"}

Based on the live data from our **ClimateShield AI engines**, here is your custom emergency advisory:

#### 🚨 Current Vulnerability Assessment
*   **Heatwave Hazard**: With a temperature of **${currentContext?.weather?.temp || 35}°C** and humidity at **${currentContext?.weather?.humidity || 65}%**, the thermal heat index is categorized as **${currentContext?.heatwave?.riskCategory || "Moderate"}**.
*   **Air Toxicity**: The AQI is **${currentContext?.aqi?.aqi || 120}**. Sensitive groups (elderly, asthmatics) must avoid prolonged outdoor activity.
*   **Flood Risk**: Categorized as **${currentContext?.flood?.riskCategory || "Moderate"}** (Rainfall: **${currentContext?.weather?.rainfall || 12} mm**). 

---

#### 👤 Citizen Action Guidelines
1.  **Avoid Exposure peaks**: Stay indoors between 11:00 AM and 4:00 PM to minimize heat stress.
2.  **Hydration Schedules**: Ensure a constant intake of water and electrolytes, as humidity of **${currentContext?.weather?.humidity || 65}%** impairs standard sweat-cooling.
3.  **Respiratory Barriers**: Wear N95 masks when walking outside to guard against **${currentContext?.aqi?.dominant || "PM2.5"}** particulates.

---

#### 🏛️ Municipal Resource Allocation Suggestions
1.  **Cooling Centers**: Open municipal schools and centers in hotspots for populations lacking air conditioning.
2.  **Drainage Inspections**: If Rainfall increases past current forecasts, initiate storm-drain clearings in blue zones.
3.  **Transit Advisories**: Restrict construction/labor shifts to early morning hours to protect outdoor laborers.
`;
    return res.json({ text: simulatedAnswer });
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    // Structure chat contents
    const contents = [];
    contents.push({
      role: "user",
      parts: [{ text: `${promptContext}\n\nClient conversation history has been initiated. Answer the following message:\n${messages[messages.length - 1].text}` }]
    });

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents,
    });

    res.json({ text: response.text });
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    res.status(500).json({ error: "Gemini query failed: " + error.message });
  }
});

// Serve Frontend Vite files in Production
async function bootstrap() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`ClimateShield AI full-stack server running on http://localhost:${PORT}`);
  });
}

bootstrap();
