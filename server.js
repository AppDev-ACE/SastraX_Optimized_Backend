import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import NodeCache from "node-cache";

import { createFastClient } from "./apiClient.js";
import { Scrapers } from "./scrapers.js";
import { messMenuData, pyqLinks, subjectAliasMap, subjectMap } from "./staticData.js";

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

// app.post("/captcha", async (req, res) => {
//     const { regNo } = req.body;
//     if (!regNo) return res.status(400).json({ success: false, message: "RegNo required" });

//     // 1. Cleanup old sessions
//     if (pendingCaptcha[regNo]) {
//         await pendingCaptcha[regNo].context.close().catch(() => {});
//     }

//     const context = await browser.newContext();
//     const page = await context.newPage();
//     let captchaFound = false;

//     try {
//         // 2. Optimization: Block heavy resources
//         await page.route('**/*', route => {
//             const req = route.request();
//             if (req.resourceType() === 'document' || req.url().includes('Captcha')) {
//                 route.continue();
//             } else {
//                 route.abort(); 
//             }
//         });

//         // 3. Intercept the Captcha Request
//         page.on('response', async (response) => {
//             const url = response.url();
//             if (url.includes('Captcha') && response.status() === 200) {
//                 try {
//                     const buffer = await response.body();
//                     captchaFound = true;
                    
//                     // Convert Buffer to Base64 String
//                     const base64Image = buffer.toString('base64');

//                     // Store session
//                     pendingCaptcha[regNo] = { context, page, timestamp: Date.now() };

//                     // Send JSON Response
//                     res.json({ 
//                         success: true, 
//                         image: `data:image/jpeg;base64,${base64Image}` 
//                     });
                    
//                 } catch (e) {
//                     console.error("Buffer read error");
//                 }
//             }
//         });

//         // 4. Navigate
//         await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 5000 });
        
//         // 5. Fallback (If interception misses)
//         setTimeout(async () => {
//             if (!captchaFound && !res.headersSent) {
//                 try {
//                     // Fallback to screenshot only if absolutely necessary
//                     const buffer = await page.locator('#imgCaptcha').screenshot();
//                     const base64Image = buffer.toString('base64');

//                     pendingCaptcha[regNo] = { context, page, timestamp: Date.now() };
                    
//                     res.json({ 
//                         success: true, 
//                         image: `data:image/png;base64,${base64Image}` 
//                     });

//                 } catch (e) {
//                     if (!res.headersSent) {
//                          await context.close();
//                          res.status(500).json({ success: false, message: "Captcha not found" });
//                     }
//                 }
//             }
//         }, 3000);

//     } catch (err) {
//         if (!res.headersSent) {
//             await context.close();
//             res.status(500).json({ success: false, message: "Connection failed" });
//         }
//     }
// });


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
            return res.status(401).json({ success: false, message: msg.trim() });
        }

        const cookies = await context.cookies();
        const token = uuidv4();
        
        // Save session
        userSessions[token] = { regNo, cookies };
        
        // CLEANUP: Close browser immediately to save RAM
        await context.close();
        delete pendingCaptcha[regNo];

        res.json({ success: true, token, message: "Login Successful" });
    } catch (err) {
        if(session?.context) await session.context.close();
        res.status(500).json({ success: false, message: "Login Error" });
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

// Attendance (Cache 10m)
app.post("/attendance", useClient, cached('att', Scrapers.getAttendance, 600));
app.post("/subjectWiseAttendance", useClient, cached('att', Scrapers.getAttendance, 600)); // Reuses same data
app.post("/hourWiseAttendance", useClient, cached('att_hour', Scrapers.getHourWise, 600));

// Marks & Grades (Cache 1h)
app.post("/internalMarks", useClient, cached('marks', Scrapers.getInternalMarks, 3600));
app.post("/ciaWiseInternalMarks", useClient, cached('marks', Scrapers.getInternalMarks, 3600)); // Reuses same data
app.post("/semGrades", useClient, cached('grades', Scrapers.getGrades, 86400));
app.post("/sgpa", useClient, cached('grades', Scrapers.getGrades, 86400)); // Reuses same data
app.post("/cgpa", useClient, cached('grades', Scrapers.getGrades, 86400)); // Reuses same data
app.post("/examSchedule", useClient, cached('exams', Scrapers.getExamSchedule, 86400));

// Finance (Cache 1h)
// Note: We use a custom handler here to split the large Dues object
app.post("/sastraDue", useClient, cached('dues', async (client) => {
    const data = await Scrapers.getDues(client);
    return { sastraDue: data.sastra.list, totalDue: data.sastra.total };
}, 3600));

app.post("/hostelDue", useClient, cached('dues', async (client) => {
    const data = await Scrapers.getDues(client); // Will hit cache if 'dues' exists
    return { hostelDue: data.hostel.list, totalDue: data.hostel.total };
}, 3600));

app.post("/feeCollections", useClient, cached('dues', async (client) => {
    const data = await Scrapers.getDues(client);
    return { feeCollections: data.history };
}, 3600));

// Profile Pic (Streaming - No Cache needed in RAM, maybe browser cache)
app.post("/profilePic", useClient, async (req, res) => {
    try {
        // Try to find image URL from profile cache first
        let imgUrl = "usermanager/image.jsp"; // Fallback
        
        const profileCache = cache.get(`${req.regNo}_profile`);
        if (profileCache?.imgUrl) imgUrl = profileCache.imgUrl;

        const response = await req.client.get(imgUrl, { responseType: 'stream' });
        res.setHeader('Content-Type', 'image/jpeg');
        response.data.pipe(res);
    } catch (err) {
        res.status(404).send("Image not found");
    }
});

// ==========================================
// 🧠 LOGIC ROUTES (Tier 3 - Zero Latency)
// ==========================================

app.get("/messMenu", (req, res) => res.json(messMenuData.boys));
app.get("/messMenuGirls", (req, res) => res.json(messMenuData.girls));
app.get("/pyq", (req, res) => res.json(pyqLinks));

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

app.post("/leaveHistory", useClient, cached('leave', Scrapers.getLeaveHistory, 60));

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