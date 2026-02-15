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
        
        // While we are here, get the image URL to cache it
        let imgRel = $('#form01 img').attr('src') || $('img[alt="Photo not found"]').attr('src');

        return {
            regNo: items[0],
            name: items[1],
            course: items[2],
            dept: items[3],
            semester: items[4],
            imgUrl: imgRel // Return this to use in profilePic route
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
        const { data } = await client.get("resource/StudentDetailsResources.jsp?resourceid=7");
        const $ = cheerio.load(data);
        const table = $("table").last();
        
        const subjects = table.find("tbody tr").slice(2, -2).map((i, el) => {
            const cols = $(el).find("td");
            return {
                code: clean($(cols[0]).text()),
                name: clean($(cols[1]).text()),
                total: clean($(cols[2]).text()),
                present: clean($(cols[3]).text()),
                absent: clean($(cols[4]).text()),
                percent: clean($(cols[5]).text())
            };
        }).get();

        const overall = clean(table.find("tbody tr").last().prev().find("td").eq(4).text());
        return { overall, subjects };
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
        const { data } = await client.get("academy/studentLeaveHistory.jsp");
        const $ = cheerio.load(data);
        return $("table").last().find("tbody tr").slice(1).map((i, el) => {
            const cols = $(el).find("td");
            return {
                applied: clean($(cols[0]).text()),
                from: clean($(cols[1]).text()),
                to: clean($(cols[2]).text()),
                reason: clean($(cols[3]).text()),
                status: clean($(cols[4]).text())
            };
        }).get();
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