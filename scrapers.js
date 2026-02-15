// scrapers.js
import * as cheerio from "cheerio";

// Helper to clean whitespace
const clean = (text) => text?.replace(/\s+/g, " ").trim() || "N/A";

export const Scrapers = {

    // --- PROFILE & BASICS ---
    getProfile: async (client) => {
        const { data } = await client.get("usermanager/home.jsp");
        const $ = cheerio.load(data);
        const items = $(".navcenter01 li").map((i, el) => $(el).text().trim()).get();
        
        // Look for the image exactly where your old code looked
        let imgRel = $('#form01 img').attr('src') || $('img[alt="Photo not found"]').attr('src');

        return {
            regNo: items[0],
            name: items[1],
            course: items[2],
            dept: items[3],
            semester: items[4],
            imgUrl: imgRel // This will be passed to profilePic
        };
    },

    getStudentStatus: async (client) => {
        const { data } = await client.get("resource/StudentDetailsResources.jsp?resourceid=59");
        const $ = cheerio.load(data);
        const rows = $("table tbody tr");
        return {
            status: clean(rows.eq(9).find("td").eq(1).text()),
            gender: clean(rows.eq(11).find("td").eq(1).text()),
            dob: clean(rows.eq(2).find("td").eq(1).text())
        };
    },

    // --- ACADEMICS ---
    getCredits: async (client) => {
        const { data } = await client.get("academy/StudentCourseRegistrationView.jsp");
        const $ = cheerio.load(data);
        return $("table").first().find("tbody tr").slice(4).map((i, el) => {
            const cols = $(el).find("td");
            return {
                code: clean($(cols[0]).text()),
                name: clean($(cols[1]).text()),
                credits: clean($(cols[5]).text())
            };
        }).get();
    },

    getFaculty: async (client) => {
        const { data } = await client.get("academy/frmStudentTimetable.jsp");
        const $ = cheerio.load(data);
        return $("table").eq(2).find("tbody tr").map((i, el) => {
            const cols = $(el).find("td");
            const code = clean($(cols[0]).text());
            if (!code || code.toLowerCase() === 'na') return null;
            return {
                code,
                name: clean($(cols[1]).text()),
                section: clean($(cols[2]).text()),
                faculty: clean($(cols[3]).text()),
                venue: clean($(cols[4]).text())
            };
        }).get().filter(Boolean);
    },

    // --- ATTENDANCE & TIMETABLE ---
    getAttendance: async (client) => {
        try {
            const { data } = await client.get("resource/StudentDetailsResources.jsp?resourceid=7");
            const $ = cheerio.load(data);
            
            // 1. Use YOUR working selector: The First Table
            const table = $("table").first();
            
            if (!table.length) {
                return { overall: "0", subjects: [], error: "Table not found" };
            }

            const rows = table.find("tbody tr");
            
            // 2. Use YOUR working logic for Overall Attendance
            // "rows.length - 2" gets the "Total" row
            // ".eq(4)" gets the percentage column
            const lastDataRow = rows.eq(rows.length - 2);
            const overall = clean(lastDataRow.find("td").eq(4).text());

            // 3. Extract Subject Details (The rows in between header and footer)
            // We skip the first 2 rows (Headers) and the last 2 rows (Total/Credits)
            const subjects = rows.slice(2, rows.length - 2).map((i, el) => {
                const cols = $(el).find("td");
                return {
                    code: clean($(cols[0]).text()),
                    name: clean($(cols[1]).text()),
                    type: clean($(cols[2]).text()), // Sometimes 'Theory'/'Lab' is here
                    totalHrs: clean($(cols[2]).text()), // Adjust index if needed based on real UI
                    present: clean($(cols[3]).text()),
                    absent: clean($(cols[4]).text()),
                    percent: clean($(cols[5]).text())
                };
            }).get();

            return { overall: overall || "N/A", subjects };

        } catch (err) {
            console.error("Attendance Error:", err.message);
            return { overall: "Error", subjects: [] };
        }
    },

    getHourWise: async (client) => {
        const { data } = await client.get("academy/studentHourWiseAttendance.jsp");
        const $ = cheerio.load(data);
        return $('table[name="table1"] tbody tr').slice(1).map((i, el) => {
            const cols = $(el).find("td");
            return {
                date: clean($(cols[0]).text()),
                periods: [1,2,3,4,5,6,7,8].map(h => clean($(cols[h]).text()))
            };
        }).get();
    },

    getTimetable: async (client) => {
        const { data } = await client.get("academy/frmStudentTimetable.jsp");
        const $ = cheerio.load(data);
        return $("table").eq(1).find("tbody tr").slice(2).map((i, el) => {
            const cols = $(el).find("td");
            if (cols.length < 12) return null;
            return {
                day: clean($(cols[0]).text()),
                periods: [1,2,3,4,5,6,7,8,9,10,11].map(x => clean($(cols[x]).text()) || "N/A")
            };
        }).get().filter(Boolean);
    },

    // --- EXAMS & RESULTS ---
    getExamSchedule: async (client) => {
        const { data } = await client.get("resource/StudentDetailsResources.jsp?resourceid=23");
        const $ = cheerio.load(data);
        return $("table").first().find("tbody tr").slice(2, -2).map((i, el) => {
            const cols = $(el).find("td");
            return {
                date: clean($(cols[0]).text()),
                time: clean($(cols[1]).text()),
                code: clean($(cols[2]).text()),
                name: clean($(cols[3]).text())
            };
        }).get();
    },

    getGrades: async (client) => {
        const { data } = await client.get("resource/StudentDetailsResources.jsp?resourceid=28");
        const $ = cheerio.load(data);
        
        const semGrades = $("table").first().find("tbody tr").slice(2, -1).map((i, el) => {
            const cols = $(el).find("td");
            return {
                sem: clean($(cols[0]).text()),
                code: clean($(cols[2]).text()),
                name: clean($(cols[3]).text()),
                grade: clean($(cols[6]).text()),
                result: clean($(cols[7]).text())
            };
        }).get();

        const sgpa = $('table[align="left"] tbody tr').slice(2).map((i, el) => {
            const cols = $(el).find("td");
            return { sem: clean($(cols[0]).text()), sgpa: clean($(cols[1]).text()) };
        }).get();

        let cgpa = "N/A";
        $("td").each((i, el) => {
            if ($(el).text().includes("CGPA")) cgpa = $(el).next().text().trim();
        });

        return { semGrades, sgpa, cgpa };
    },

    getInternalMarks: async (client) => {
        const { data } = await client.get("resource/StudentDetailsResources.jsp?resourceid=22");
        const $ = cheerio.load(data);
        
        const marks = $("table").first().find("tbody tr").slice(2).map((i, el) => {
            const cols = $(el).find("td");
            return {
                code: clean($(cols[0]).text()),
                name: clean($(cols[1]).text()),
                marks: clean($(cols[2]).text())
            };
        }).get();

        const ciaWise = $("table").eq(1).find("tbody tr").slice(2).map((i, el) => {
            const cols = $(el).find("td");
            return {
                code: clean($(cols[0]).text()),
                name: clean($(cols[1]).text()),
                component: clean($(cols[2]).text()),
                mark: clean($(cols[3]).text()) + "/" + clean($(cols[4]).text())
            };
        }).get();

        return { marks, ciaWise };
    },

    // --- FINANCE (Parallel Fetch) ---
    getDues: async (client) => {
        const [sastraRes, hostelRes, feeCollRes] = await Promise.all([
            client.get("accounts/Feedue.jsp?arg=1"),
            client.get("accounts/Feedue.jsp?arg=2"),
            client.get("resource/StudentDetailsResources.jsp?resourceid=12")
        ]);

        const parseDue = (html) => {
            const $ = cheerio.load(html);
            const rows = $("table").first().find("tbody tr");
            const list = rows.slice(2, -1).map((i, el) => {
                const cols = $(el).find("td");
                return {
                    sem: clean($(cols[1]).text()),
                    desc: clean($(cols[2]).text()),
                    amount: clean($(cols[4]).text()),
                    dueDate: clean($(cols[3]).text())
                };
            }).get();
            
            let total = "0";
            rows.each((i, el) => {
                if ($(el).text().includes("Total")) total = $(el).find("td").eq(1).text().trim();
            });
            return { list, total };
        };

        const parseCollections = (html) => {
             const $ = cheerio.load(html);
             return $("table").first().find("tbody tr").slice(2, -2).map((i, el) => {
                const cols = $(el).find("td");
                return {
                    sem: clean($(cols[0]).text()),
                    date: clean($(cols[4]).text()),
                    amount: clean($(cols[3]).text()),
                    desc: clean($(cols[2]).text())
                };
             }).get();
        };

        return {
            sastra: parseDue(sastraRes.data),
            hostel: parseDue(hostelRes.data),
            history: parseCollections(feeCollRes.data)
        };
    },

    // --- FORMS & APPLICATIONS ---
    getLeaveHistory: async (client) => {
    try {
        const { data } = await client.get("academy/HostelStudentLeaveApplication.jsp");
        const $ = cheerio.load(data);
        
        // Check for session timeout
        if (data.includes("User Login")) throw new Error("Session Expired");

        // 1. Find ALL tables on the page
        const tables = $("table");
        let targetTable = null;

        // 2. Look for the table that specifically contains the leave headers
        tables.each((i, el) => {
            const text = $(el).text();
            if (text.includes("Leave Type") && text.includes("From Date")) {
                targetTable = $(el);
                return false; // Found it, break loop
            }
        });

        if (!targetTable) {
            return { leaveHistory: "No records found" };
        }

        const leaveHistory = [];

        // 3. Use the exact attribute from your Puppeteer code: [onclick]
        // This is the most reliable way to identify data rows vs header rows
        const rows = targetTable.find("tr[onclick]");

        rows.each((i, row) => {
            const columns = $(row).find("td");
            
            if (columns.length >= 7) {
                leaveHistory.push({
                    sno: $(columns[0]).text().trim(),
                    leaveType: $(columns[1]).text().trim(),
                    fromDate: $(columns[2]).text().trim(),
                    toDate: $(columns[3]).text().trim(),
                    noOfDays: $(columns[4]).text().trim(),
                    reason: $(columns[5]).text().trim(),
                    status: $(columns[6]).text().trim()
                });
            }
        });

        return { 
            leaveHistory: leaveHistory.length > 0 ? leaveHistory : "No records found" 
        };

    } catch (err) {
        console.error("Leave Scrape Error:", err.message);
        throw err;
    }
},

    submitGrievance: async (client, payload) => {
        // Optimized form submission
        const params = new URLSearchParams();
        params.append('cmbGrievanceType', payload.grievanceType);
        params.append('cmbGrievanceCategory', payload.grievanceCategory);
        params.append('txtSubject', payload.grievanceSubject);
        params.append('txtSubjectDescription', payload.grievanceDetail);
        
        // Handle hidden fields if necessary by fetching GET first (omitted for speed if standard)
        
        const { data } = await client.post("academy/StudentsGrievances.jsp", params);
        if(data.includes("success") || data.includes("Saved Successfully")) {
            return { success: true, message: "Submitted successfully" };
        }
        return { success: false, message: "Submission failed or needs manual check" };
    }
};