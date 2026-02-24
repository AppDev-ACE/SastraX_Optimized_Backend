import "dotenv/config";
import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import NodeCache from "node-cache";

import { createFastClient } from "./apiClient.js";
import { Scrapers } from "./scrapers.js";
import { messMenuData, pyqLinks, subjectAliasMap, subjectMap, materialLinks } from "./staticData.js";

import { getSession, saveSession, updateSessionCookies } from "./sessionStore.js";

import dotenv from "dotenv";
dotenv.config();

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
// const useClient = (req, res, next) => {
//     const { token } = req.body;
//     if (!token) return res.status(400).json({ error: "Token required" });

//     const session = userSessions[token];
//     if (!session) return res.status(401).json({ error: "Session expired. Login again." });

//     req.client = createFastClient(session.cookies);
//     req.regNo = session.regNo;
//     next();
// };

const useClient = async (req, res, next) => {
  const { token } = req.body;

  const session = await getSession(token);

  if (!session)
    return res.status(401).json({ error: "Session expired" });

  req.client = createFastClient(session.cookies);
  req.regNo = session.regNo;
  req.session = session;

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
    const captchaId = uuidv4();

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });

    const selector = "#imgCaptcha";

    await page.waitForSelector(selector, { state: "visible" });

    await page.waitForFunction((sel) => {
      const img = document.querySelector(sel);
      return img && img.complete && img.naturalWidth > 0;
    }, selector);

    const buffer = await page.locator(selector).screenshot();

    pendingCaptcha[captchaId] = {
      context,
      page,
      createdAt: Date.now()
    };

    setTimeout(async () => {
        if (pendingCaptcha[captchaId]) {
            try { await pendingCaptcha[captchaId].context.close(); } catch {}
            delete pendingCaptcha[captchaId];
        }
        }, 60000);

    res.json({
      captchaId,
      image: buffer.toString("base64")
    });

  } catch (e) {
    res.status(500).json({ error: "Captcha load failed" });
  }
});


app.post("/login", async (req, res) => {
  const { captchaId, regNo, pwd, captcha } = req.body;

  const session = pendingCaptcha[captchaId];
  if (!session) {
    return res.status(400).json({ success: false, message: "Captcha expired" });
  }

  const { page, context } = session;

  try {
    // Fill login form
    await page.fill("#txtRegNumber", regNo);
    await page.fill("#txtPwd", pwd);
    await page.fill("#answer", captcha);

    // Click login
    await Promise.all([
      page.click('input[type="button"]'),
      page.waitForLoadState("domcontentloaded")
    ]);

    /**
     * ⭐ CRITICAL:
     * Wait for either success OR error
     */
    await Promise.race([
      page.waitForSelector(".navcenter01", { timeout: 7000 }), // success page
      page.waitForSelector(".ui-state-error", { timeout: 7000 }) // error
    ]);

    const successEl = await page.$(".navcenter01");

    // ❌ LOGIN FAILED
    if (!successEl) {
      const err = await page.$(".ui-state-error");
      const msg = err ? await err.textContent() : "Invalid credentials / captcha";

      await context.close();
      delete pendingCaptcha[captchaId];

      return res.status(401).json({
        success: false,
        message: msg.trim()
      });
    }

    // ✅ LOGIN SUCCESS
    const cookies = await context.cookies();
    const token = uuidv4();

    // userSessions[token] = {
    //   regNo,
    //   pwd,
    //   cookies,
    //   createdAt: Date.now()
    // };

    await saveSession(token, {
        regNo,
        pwd,
        cookies,
        createdAt: Date.now()
    });

    // Close context to save RAM
    await context.close();
    delete pendingCaptcha[captchaId];

    return res.json({
      success: true,
      token
    });

  } catch (e) {
    console.error("Login error:", e.message);

    try { await context.close(); } catch {}
    delete pendingCaptcha[captchaId];

    return res.status(500).json({
      success: false,
      message: "Login failed"
    });
  }
});

app.post("/profilePic", async (req, res) => {
    const { token } = req.body;
    const session = await getSession(token);

    if (!session || !session.cookies) {
        return res.status(401).json({ success: false, message: "Session expired" });
    }

    let context;
    try {
        // Spin up a temporary headless context using the authenticated cookies
        context = await browser.newContext();
        await context.addCookies(session.cookies);
        const page = await context.newPage();
        
        await page.goto("https://webstream.sastra.edu/sastrapwi/usermanager/home.jsp", { 
            waitUntil: "networkidle", 
            timeout: 15000 
        });

        const imgSelector = '#form01 img';
        const profileImg = page.locator(imgSelector);
        await profileImg.waitFor({ state: 'visible', timeout: 5000 });

        await page.waitForFunction((sel) => {
            const img = document.querySelector(sel);
            return img && img.complete && img.naturalWidth > 0;
        }, imgSelector);

        const buffer = await profileImg.screenshot({ 
            type: "png",
            animations: "disabled" 
        });

        // Immediately close the context to free memory
        await context.close();
        
        res.setHeader("Content-Type", "image/png");
        res.send(buffer);

    } catch (err) {
        if (context) {
            try { await context.close(); } catch (e) {}
        }
        console.error("Profile Pic Error:", err.message);
        res.status(500).json({ success: false, message: "Failed to capture stable image" });
    }
});



app.post("/refresh-captcha", async (req, res) => {
    const session = await getSession(req.body.token);
    
    // Ensure session exists and has a saved password
    if (!session || !session.pwd) {
        return res.status(401).json({ message: "Session expired or password missing" });
    }

    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        
        // Navigate and wait for captcha to load
        await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 10000 });
        await page.waitForSelector("#imgCaptcha", { state: 'visible', timeout: 5000 });
        
        // Ensure image has actual dimensions before screenshot
        await page.waitForFunction(() => {
            const img = document.querySelector('#imgCaptcha');
            return img && img.complete && img.naturalWidth > 0;
        }, { timeout: 5000 });

        const buffer = await page.locator("#imgCaptcha").screenshot();

        // Prevent memory leak: Auto-kill this context if user abandons the login
        const timeoutId = setTimeout(async () => {
            if (pendingRefresh[req.body.token]) {
                try {
                    await pendingRefresh[req.body.token].context.close();
                } catch (e) {
                    // Ignore close errors
                }
                delete pendingRefresh[req.body.token];
                console.log(`Cleaned up abandoned refresh session for token: ${req.body.token}`);
            }
        }, 45000); // 45 seconds to solve captcha

        // Save context and page so /refresh-login can use them
        pendingRefresh[req.body.token] = { 
            context, 
            page, 
            timeoutId 
        };

        res.set("Content-Type", "image/png");
        res.send(buffer);

    } catch (e) {
        console.error("Refresh Captcha Error:", e.message);
        res.status(500).json({ message: "Failed to load captcha" });
    }
});


app.post("/refresh-login", async (req, res) => {
    const { token, captcha } = req.body;
    const refresh = pendingRefresh[token];
    const session = await getSession(token);

    if (!refresh || !session) {
        return res.status(400).json({ message: "Refresh session expired. Please request a new captcha." });
    }

    // Clear the auto-kill timer since the user is completing the flow
    clearTimeout(refresh.timeoutId);

    try {
        const { page, context } = refresh;

        // Auto-fill stored credentials and the user's new captcha
        await page.fill("#txtRegNumber", session.regNo);
        await page.fill("#txtPwd", session.pwd);
        await page.fill("#answer", captcha);

        // Click submit
        await page.click('input[type="button"]');

        // Wait for successful redirect OR an error message to appear
        await page.waitForFunction(() => {
            const url = window.location.href;
            const err = document.querySelector('.ui-state-error');
            return (!url.includes("login") && !url.includes("index")) || err;
        }, { timeout: 10000 });

        const error = await page.$('.ui-state-error');
        if (error) {
            const msg = await error.textContent();
            throw new Error(msg.trim());
        }

        // Success: Extract authenticated cookies and update session
        //userSessions[token].cookies = await context.cookies();
        const newCookies = await context.cookies();
        await updateSessionCookies(token, newCookies);

        // Clean up the browser context to free RAM
        await context.close();
        delete pendingRefresh[token];

        res.json({ success: true, message: "Session refreshed successfully" });

    } catch (e) {
        // Clean up on failure
        if (refresh.context) {
            try {
                await refresh.context.close();
            } catch (err) {}
        }
        delete pendingRefresh[token];

        res.status(401).json({ message: e.message || "Refresh failed" });
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

app.post("/syllabus", useClient, async (req, res) => {
    try {
        const { syllabus } = await Scrapers.getSyllabus(req.client);
        res.json({ success: true, syllabus: syllabus });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

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
        
//         // Navigate and wait for the network to be completely quiet
//         await page.goto("https://webstream.sastra.edu/sastrapwi/usermanager/home.jsp", { 
//             waitUntil: "networkidle", 
//             timeout: 15000 
//         });

//         const imgSelector = '#form01 img';
        
//         // 1. Wait for the element to be attached and visible
//         const profileImg = page.locator(imgSelector);
//         await profileImg.waitFor({ state: 'visible', timeout: 5000 });

//         // 2. Optimization: Ensure the image has actual dimensions (loaded)
//         await page.waitForFunction((sel) => {
//             const img = document.querySelector(sel);
//             return img && img.complete && img.naturalWidth > 0;
//         }, imgSelector);

//         // 3. Take screenshot with 'animations: disabled' to prevent stability errors
//         const buffer = await profileImg.screenshot({ 
//             type: "png",
//             animations: "disabled" 
//         });

//         res.setHeader("Content-Type", "image/png");
//         res.send(buffer);

//     } catch (err) {
//         console.error("Profile Pic Error:", err.message);
//         res.status(500).json({ success: false, message: "Failed to capture stable image" });
//     } finally {
//         if (page) await page.close(); 
        
//         // Close context to save RAM as we discussed
//         try {
//             await context.close();
//             session.context = null;
//         } catch (e) {
//             console.error("Error closing context:", e);
//         }
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


// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Optimized Sastra Scraper running on ${PORT}`));