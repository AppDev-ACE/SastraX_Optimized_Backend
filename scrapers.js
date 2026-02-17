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
                credit: clean($(cols[5]).text()),
                grade: clean($(cols[6]).text()),
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
        
        // Table 1: Total Internal Marks
        const marks = $("table").first().find("tbody tr").slice(2).map((i, el) => {
            const cols = $(el).find("td");
            return {
                code: clean($(cols[0]).text()),
                name: clean($(cols[1]).text()),
                totalCIAMarks: clean($(cols[2]).text()) // Renamed to match frontend expectation
            };
        }).get();

        // Table 2: Detailed CIA-Wise Marks
        const ciaWise = $("table").eq(1).find("tbody tr").slice(2).map((i, el) => {
            const cols = $(el).find("td");
            return {
                subjectCode: clean($(cols[0]).text()),
                subjectName: clean($(cols[1]).text()),
                component: clean($(cols[2]).text()),
                marksObtained: clean($(cols[3]).text()),
                maxMarks: clean($(cols[4]).text())
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
    const { data } = await client.get(
      "academy/HostelStudentLeaveApplication.jsp"
    );

    const $ = cheerio.load(data);
    const leaveHistory = [];

    // ❌ DO NOT use tbody for Axios
    $("table#StudentLeaveApplciation tbody tr").each((_, row) => {
      const td = $(row).find("td");
      if (td.length < 7) return;

      leaveHistory.push({
        sno: td.eq(0).text().trim(),
        leaveType: td.eq(1).text().trim(),
        fromDate: td.eq(2).text().trim(),
        toDate: td.eq(3).text().trim(),
        noOfDays: td.eq(4).text().trim(),
        reason: td.eq(5).text().trim(),
        status: td.eq(6).text().trim()
      });
    });

    return { leaveHistory };

  } catch (err) {
    console.error("Leave Scrape Error:", err.message);
    throw err;
  }
},



    submitLeave: async (client, payload) => {
    const TARGET_URL = "academy/HostelStudentLeaveApplication.jsp";

    try {
        // 1. GET page to fetch hidden tokens
        console.log("🔹 Step 1: Fetching form...");
        const getRes = await client.get(TARGET_URL);
        const $ = cheerio.load(getRes.data);
        
        const params = new URLSearchParams();

        // 2. Scrape ALL hidden inputs (Critical for JSP)
        $('input[type="hidden"]').each((i, el) => {
            const name = $(el).attr('name');
            const value = $(el).attr('value');
            if (name) params.append(name, value || '');
        });

        // 3. Format Date strictly to dd/MM/yyyy
        // If payload.fromDate is "2026-02-15", this fixes it to "15/02/2026"
        const cleanDate = (d) => d.split(' ')[0].replace(/-/g, '/').split('/').reverse().join('/');
        
        // Use the function above OR ensure your frontend sends dd/MM/yyyy
        // For debugging, let's log exactly what we are sending
        console.log(`🔹 Sending Dates: From ${payload.fromDate} To ${payload.toDate}`);

        params.append('txtLeaveType', payload.leaveType); 
        params.append('txtFromDate', payload.fromDate); 
        params.append('txtToDate', payload.toDate);
        params.append('txtNoofDays', payload.noOfDays);
        params.append('txtReason', payload.reason);
        
        // CRITICAL: The submit button itself must be sent
        params.append('btSubmit', 'Submit'); 

        // 4. POST the data
        console.log("🔹 Step 2: Submitting...");
        const { data } = await client.post(TARGET_URL, params, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": "https://webstream.sastra.edu/sastrapwi/academy/HostelStudentLeaveApplication.jsp",
                "Origin": "https://webstream.sastra.edu"
            }
        });

        // 5. DEBUGGING THE RESPONSE
        const $response = cheerio.load(data);
        
        // Attempt to find the specific error message on the page
        const uiError = $response(".ui-state-error").text().trim();
        const alertError = data.match(/alert\('([^']+)'\)/); // Regex to catch JS alerts
        const title = $response("title").text();

        console.log("--- 🔴 SERVER RESPONSE DEBUG 🔴 ---");
        if (uiError) console.log("UI Error:", uiError);
        if (alertError) console.log("JS Alert:", alertError[1]);
        if (!uiError && !alertError) console.log("Page Title:", title);
        
        // Check for success
        if (data.includes("Saved Successfully") || data.includes("Applied Successfully")) {
            return { success: true, message: "Leave applied successfully" };
        } else {
            // Return the specific error found
            const specificError = uiError || (alertError ? alertError[1] : "Unknown Error - Check Logs");
            return { success: false, message: specificError };
        }

    } catch (error) {
        console.error("❌ Network Error:", error.message);
        return { success: false, message: "Connection Failed" };
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