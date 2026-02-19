import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import NodeCache from "node-cache";

import { createFastClient } from "./apiClient.js";
import { Scrapers } from "./scrapers.js";
import { messMenuData, pyqLinks, subjectAliasMap, subjectMap, materialLinks } from "./staticData.js";

const app = express();
app.use(cors());
app.use(express.json());

const BASE = "https://webstream.sastra.edu/sastrapwi/";

// --- OPTIMIZATION 1: Caching ---
// Cache heavily used data to prevent hitting University servers too often
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // Default 5 mins

// --- OPTIMIZATION 2: Globals ---
let browser;
const pendingCaptcha = {}; // RegNo -> { context, page }
const userSessions = {};   // Token -> { regNo, cookies }
const pendingRefresh = {}; // Token -> { context, page }

// --- LAUNCH BROWSER (Once) ---
(async () => {
    browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Optimizes for Docker/Linux
    });
    console.log("✅ Playwright Engine Ready");
})();

// --- MIDDLEWARE: Client Hydration ---
// Converts Token -> Axios Client
const useClient = (req, res, next) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });

    const session = userSessions[token];
    if (!session) return res.status(401).json({ error: "Session expired. Login again." });

    req.client = createFastClient(session.cookies);
    req.regNo = session.regNo;
    next();
};

// --- HELPER: Cached Route Handler ---
// Automatically checks cache before executing scraper
const cached = (keySuffix, scraperFn, ttl = 300) => async (req, res) => {
    const cacheKey = `${req.regNo}_${keySuffix}`;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
        return res.json({ success: true, ...cachedData, source: 'cache' });
    }

    try {
        const data = await scraperFn(req.client);
        cache.set(cacheKey, data, ttl);
        res.json({ success: true, ...data, source: 'network' });
    } catch (err) {
        console.error(`Error in ${keySuffix}:`, err.message);
        res.status(500).json({ success: false, message: "Fetch failed", error: err.message });
    }
};

// ==========================================
// 🔐 AUTH ROUTES (Tier 1 - Playwright)
// ==========================================

app.post("/captcha", async (req, res) => {
    try {
        const { regNo } = req.body;
        if (!regNo) return res.status(400).send("RegNo required");

        // 1. Close previous session if it exists to free memory
        if (pendingCaptcha[regNo]) {
            try {
                await pendingCaptcha[regNo].context.close();
            } catch (e) { /* ignore error if already closed */ }
        }

        // 2. Launch a new context
        const context = await browser.newContext();
        const page = await context.newPage();

        // OPTIMIZATION: Block heavy resources to load page faster
        await page.route('**/*.{css,woff,woff2,js,jpg,jpeg,gif,webp}', route => {
            const url = route.request().url();
            // Allow the captcha image and the main page, block everything else
            if (url.includes('Captcha') || url === BASE || url.includes('jquery')) {
                route.continue();
            } else {
                route.abort();
            }
        });

        // 3. Navigate with a timeout
        try {
            await page.goto(BASE, { 
                waitUntil: 'domcontentloaded', 
                timeout: 10000 // 10s timeout for navigation
            });
        } catch (e) {
            await context.close();
            return res.status(504).json({ error: "University server timeout" });
        }

        // 4. Wait specifically for the Captcha Image to be visible
        const captchaSelector = '#imgCaptcha';
        await page.waitForSelector(captchaSelector, { state: 'visible', timeout: 5000 });

        // 5. CRITICAL: Wait until the image actually has data (naturalWidth > 0)
        // This fixes the "blank screenshot" issue
        await page.waitForFunction((selector) => {
            const img = document.querySelector(selector);
            return img && img.complete && img.naturalWidth > 0;
        }, captchaSelector, { timeout: 5000 });

        // 6. Take Screenshot
        const element = page.locator(captchaSelector);
        const buffer = await element.screenshot();
        
        // Store session for login
        pendingCaptcha[regNo] = { context, page, timestamp: Date.now() };
        
        // Send image
        res.set('Content-Type', 'image/png');
        res.send(buffer);

    } catch (err) {
        console.error("Captcha Error:", err.message);
        // Clean up on error
        if (pendingCaptcha[regNo]?.context) {
            await pendingCaptcha[regNo].context.close();
            delete pendingCaptcha[regNo];
        }
        res.status(500).json({ error: "Failed to load captcha. Try again." });
    }
});


app.post("/login", async (req, res) => {
    const { regNo, pwd, captcha } = req.body;
    const session = pendingCaptcha[regNo];

    if (!session) return res.status(400).json({ message: "Captcha expired" });

    try {
        const { page, context } = session;
        await page.fill("#txtRegNumber", regNo);
        await page.fill("#txtPwd", pwd);
        await page.fill("#answer", captcha);

        await Promise.all([
            page.click('input[type="button"]'),
            page.waitForLoadState('domcontentloaded')
        ]);

        const error = await page.$('.ui-state-error');
        if (error) {
            const msg = await error.textContent();
            await context.close();
            delete pendingCaptcha[regNo];
            return res.status(401).json({ success: false, message: msg.trim() });
        }

        const cookies = await context.cookies();
        const token = uuidv4();
        
        // Save session with a timestamp for cleanup
        userSessions[token] = { 
            regNo, 
            context, 
            cookies,
            pwd: pwd,
            createdAt: Date.now() // Track when this was created
        };
        
        // Remove from pending, but DO NOT close context
        delete pendingCaptcha[regNo];

        res.json({ success: true, token, message: "Login Successful" });
    } catch (err) {
        if(session?.context) await session.context.close();
        delete pendingCaptcha[regNo];
        res.status(500).json({ success: false, message: "Login Error" });
    }
});

// REFRESH
app.post("/refresh-captcha", async (req, res) => {
    const { token } = req.body;
    const session = userSessions[token];

    if (!session || !session.pwd) {
        return res.status(401).json({ 
            success: false, 
            message: "Session expired or password not saved. Please login manually." 
        });
    }

    try {
        const context = await browser.newContext();
        const page = await context.newPage();

        // OPTIMIZATION: Block heavy resources to load page faster
        await page.route('**/*.{css,woff,woff2,js,jpg,jpeg,gif,webp}', route => {
            const url = route.request().url();
            // Allow the captcha image and the main page, block everything else
            if (url.includes('Captcha') || url === BASE || url.includes('jquery')) {
                route.continue();
            } else {
                route.abort();
            }
        });

        // 3. Navigate with a timeout
        try {
            await page.goto(BASE, { 
                waitUntil: 'domcontentloaded', 
                timeout: 10000 // 10s timeout for navigation
            });
        } catch (e) {
            await context.close();
            return res.status(504).json({ error: "University server timeout" });
        }
        
        // Wait for captcha image
        const captchaSelector = '#imgCaptcha';
        await page.waitForSelector(captchaSelector, { state: 'visible', timeout: 5000 });

        await page.waitForFunction((selector) => {
            const img = document.querySelector(selector);
            return img && img.complete && img.naturalWidth > 0;
        }, captchaSelector, { timeout: 5000 });

        // 6. Take Screenshot
        const element = page.locator(captchaSelector);
        const buffer = await element.screenshot();

        // Store this specific page context mapped to the USER TOKEN
        pendingRefresh[token] = { 
            page, 
            context, 
            regNo: session.regNo, 
            pwd: session.pwd // Retrieve pwd from session store
        };

        res.set("Content-Type", "image/png");
        res.send(buffer);

    } catch (err) {
        console.error("Refresh Captcha Error:", err);
        res.status(500).json({ success: false, message: "Failed to load captcha" });
    }
});

app.post("/refresh-login", async (req, res) => {
  const { token, captcha } = req.body;
  const refreshSession = pendingRefresh[token];

  if (!refreshSession) {
    return res.status(400).json({
      success: false,
      message: "Refresh session expired"
    });
  }

  const { page, context, regNo, pwd } = refreshSession;

  try {
    // 🔐 AUTO-FILL STORED CREDENTIALS
    await page.fill("#txtRegNumber", regNo);
    await page.fill("#txtPwd", pwd);
    await page.fill("#answer", captcha);

    await Promise.all([
      page.click('input[type="button"]'),
      page.waitForLoadState("networkidle")
    ]);

    // ✅ STRONG SUCCESS CHECK
    const url = page.url();
    if (url.includes("login") || url.includes("index")) {
      throw new Error("Invalid captcha or refresh login failed");
    }

    // Extract cookies
    const newCookies = await context.cookies();

    // 🔍 Verify cookies are authenticated
    const testClient = createFastClient(newCookies);
    const testResp = await testClient.get("usermanager/home.jsp");

    if (testResp.data.includes("User Login")) {
      throw new Error("Session not authenticated after refresh");
    }

    // ✅ Update session cookies
    userSessions[token].cookies = newCookies;

    delete pendingRefresh[token];

    res.json({
      success: true,
      message: "Session refreshed successfully"
    });

  } catch (err) {
    await context.close();
    delete pendingRefresh[token];

    res.status(401).json({
      success: false,
      message: err.message
    });
  }
});

// ==========================================
// ⚡ ACADEMIC ROUTES (Tier 2 - Axios)
// ==========================================

// Profile (Cache 24h)
app.post("/profile", useClient, cached('profile', Scrapers.getProfile, 86400));
app.post("/studentStatus", useClient, cached('status', Scrapers.getStudentStatus, 86400));
app.post("/currentSemCredits", useClient, cached('credits', Scrapers.getCredits, 86400));
app.post("/facultyList", useClient, cached('faculty', Scrapers.getFaculty, 86400));
app.post("/courseMap", useClient, cached('faculty', Scrapers.getFaculty, 86400)); // Reuses same data


app.post("/subjectWiseAttendance", useClient, cached('att', Scrapers.getAttendance, 0)); // Reuses same data
app.post("/hourWiseAttendance", useClient, cached('att_hour', Scrapers.getHourWise, 0));

// Marks & Grades (Cache 1h)
// --- MARKS & GRADES (Direct Fetch / No Cache) ---

// --- MARKS (Direct Network Fetch) ---

app.post("/internalMarks", useClient, async (req, res) => {
    try {
        // Fetch both, but return only 'marks'
        const { marks } = await Scrapers.getInternalMarks(req.client);
        res.json({ success: true, internalMarks: marks });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/ciaWiseInternalMarks", useClient, async (req, res) => {
    try {
        // Fetch both, but return only 'ciaWise'
        const { ciaWise } = await Scrapers.getInternalMarks(req.client);
        res.json({ success: true, ciaWiseInternalMarks: ciaWise });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/semGrades", useClient, async (req, res) => {
    try {
        // Scrapers.getGrades returns { semGrades, sgpa, cgpa }
        const data = await Scrapers.getGrades(req.client);
        res.json({ success: true, ...data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Exam Schedule
app.post("/examSchedule", useClient, async (req, res) => {
    try {
        const examSchedule = await Scrapers.getExamSchedule(req.client);
        res.json({ success: true, examSchedule });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ---------- SASTRA DUE (No Cache) ----------
app.post("/sastraDue", useClient, async (req, res) => {
    try {
        const data = await Scrapers.getDues(req.client);
        res.json({ 
            success: true, 
            sastraDue: data.sastra.list, 
            totalDue: data.sastra.total,
            source: 'network' 
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to fetch Sastra due", error: err.message });
    }
});

// ---------- HOSTEL DUE (No Cache) ----------
app.post("/hostelDue", useClient, async (req, res) => {
    try {
        const data = await Scrapers.getDues(req.client);
        res.json({ 
            success: true, 
            hostelDue: data.hostel.list, 
            totalDue: data.hostel.total,
            source: 'network' 
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to fetch Hostel due", error: err.message });
    }
});

// ---------- FEE COLLECTIONS (No Cache) ----------
app.post("/feeCollections", useClient, async (req, res) => {
    try {
        const data = await Scrapers.getDues(req.client);
        res.json({ 
            success: true, 
            feeCollections: data.history,
            source: 'network' 
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to fetch fee collections", error: err.message });
    }
});

// Profile Pic (Streaming - No Cache needed in RAM, maybe browser cache)
app.post("/profilePic", async (req, res) => {
    const { token } = req.body;
    const session = userSessions[token];

    if (!session || !session.context) {
        return res.status(401).json({ success: false, message: "Session expired" });
    }

    const { context } = session;
    let page;

    try {
        page = await context.newPage();
        
        // Navigate and wait for the network to be completely quiet
        await page.goto("https://webstream.sastra.edu/sastrapwi/usermanager/home.jsp", { 
            waitUntil: "networkidle", 
            timeout: 15000 
        });

        const imgSelector = '#form01 img';
        
        // 1. Wait for the element to be attached and visible
        const profileImg = page.locator(imgSelector);
        await profileImg.waitFor({ state: 'visible', timeout: 5000 });

        // 2. Optimization: Ensure the image has actual dimensions (loaded)
        await page.waitForFunction((sel) => {
            const img = document.querySelector(sel);
            return img && img.complete && img.naturalWidth > 0;
        }, imgSelector);

        // 3. Take screenshot with 'animations: disabled' to prevent stability errors
        const buffer = await profileImg.screenshot({ 
            type: "png",
            animations: "disabled" 
        });

        res.setHeader("Content-Type", "image/png");
        res.send(buffer);

    } catch (err) {
        console.error("Profile Pic Error:", err.message);
        res.status(500).json({ success: false, message: "Failed to capture stable image" });
    } finally {
        if (page) await page.close(); 
        
        // Close context to save RAM as we discussed
        try {
            await context.close();
            session.context = null;
        } catch (e) {
            console.error("Error closing context:", e);
        }
    }
});

// app.post("/profilePic", async (req, res) => {
//     const { token } = req.body;
//     const session = userSessions[token];

//     if (!session || !session.context) {
//         return res.status(401).json({ success: false, message: "Session expired" });
//     }

//     const { context } = session;
//     let page;

//     try {
//         page = await context.newPage();

//         // 1. Navigate to the page
//         await page.goto("https://webstream.sastra.edu/sastrapwi/usermanager/home.jsp", {
//             waitUntil: "domcontentloaded", // Faster than networkidle
//             timeout: 15000
//         });

//         // 2. SMART SELECTOR: Based on your screenshot, the real image is inside #form01
//         // and its URL always contains "SImage".
//         // This line makes Playwright WAIT until the real photo URL is swapped in.
//         // It prevents grabbing the "loading..." icon.
//         const imgSelector = '#form01 img[src*="SImage"]';
        
//         try {
//             await page.waitForSelector(imgSelector, { state: 'attached', timeout: 8000 });
//         } catch (e) {
//             throw new Error("Profile image never loaded (SImage URL missing)");
//         }

//         // 3. Extract the Source URL
//         const imageSrc = await page.getAttribute(imgSelector, 'src');
//         if (!imageSrc) throw new Error("Image source is empty");

//         // 4. Fetch the image data INSIDE the browser
//         // This handles the relative path ("../../resource/...") and cookies automatically.
//         const base64Data = await page.evaluate(async (src) => {
//             const response = await fetch(src);
//             const blob = await response.blob();
//             return new Promise((resolve, reject) => {
//                 const reader = new FileReader();
//                 // Returns string like "data:image/jpeg;base64,..."
//                 reader.onloadend = () => resolve(reader.result); 
//                 reader.onerror = reject;
//                 reader.readAsDataURL(blob);
//             });
//         }, imageSrc);

//         // 5. Convert Base64 back to binary buffer
//         const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
//         if (!matches || matches.length !== 3) {
//             throw new Error("Invalid image data received");
//         }

//         const contentType = matches[1]; // e.g., 'image/jpeg'
//         const dataBuffer = Buffer.from(matches[2], 'base64');

//         res.setHeader("Content-Type", contentType);
//         res.send(dataBuffer);

//     } catch (err) {
//         console.error("Profile Pic Error:", err.message);
//         res.status(500).json({ success: false, message: "Failed to load profile picture" });
//     } finally {
//         if (page) await page.close();
        
//         // Optional: Close context if you want to kill the session immediately
//         // try { await context.close(); session.context = null; } catch (e) {}
//     }
// });


app.get("/messMenu", (req, res) => res.json(messMenuData.boys));
app.get("/messMenuGirls", (req, res) => res.json(messMenuData.girls));
app.get("/pyq", (req, res) => res.json(pyqLinks));
app.get("/materials", (req, res) => res.json(materialLinks));

app.post("/chatbot", (req, res) => {
    const msg = (req.body.message || "").toLowerCase();
    const key = Object.keys(subjectAliasMap).find(k => msg.includes(k));
    
    if (key) {
        const code = subjectAliasMap[key];
        res.json({ reply: `Here are the PYQs for ${key}: ${subjectMap[code]}` });
    } else {
        res.json({ reply: "Sorry, no PYQs found for that subject." });
    }
});

app.post("/timetable", useClient, cached('timetable', Scrapers.getTimetable, 604800)); // 7 Days cache

app.post("/bunk", useClient, async (req, res) => {
    // 1. Fetch from Cache or Network
    let timetable = cache.get(`${req.regNo}_timetable`);
    let attendance = cache.get(`${req.regNo}_att`);

    if (!timetable || !attendance) {
        // If not in cache, we MUST fetch them now
        try {
            const [tt, att] = await Promise.all([
                Scrapers.getTimetable(req.client),
                Scrapers.getAttendance(req.client)
            ]);
            // Manually set cache
            cache.set(`${req.regNo}_timetable`, tt, 604800);
            cache.set(`${req.regNo}_att`, att, 600);
            timetable = tt; 
            attendance = att;
        } catch(e) {
            return res.status(500).json({ error: "Could not fetch data for calculation" });
        }
    }

    // 2. Perform Bunk Calculation (Pure JS)
    // ... Insert your math logic here using `timetable` and `attendance.subjects` ...
    
    res.json({ success: true, bunkStats: "Calculated Data" });
});

// ==========================================
// 📝 FORM ROUTES
// ==========================================


app.post("/leaveApplication", useClient, async (req, res) => {
    // Optional: Dry Run to test payload without submitting
    if (req.body.dryRun) {
        return res.json({ success: true, message: "Dry Run: Payload received", data: req.body });
    }

    const result = await Scrapers.submitLeave(req.client, req.body);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

app.post("/grievances", useClient, async (req, res) => {
    if (req.body.dryRun) {
        return res.json({ success: true, message: "Dry Run: Data valid" });
    }
    const result = await Scrapers.submitGrievance(req.client, req.body);
    res.json(result);
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Optimized Sastra Scraper running on ${PORT}`));