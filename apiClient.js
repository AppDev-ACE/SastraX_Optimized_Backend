import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

export const createFastClient = (cookies = []) => {
    const jar = new CookieJar();
    
    // Safely load cookies from Login into the jar
    if (cookies && Array.isArray(cookies)) {
        cookies.forEach(c => {
            try {
                // If domain is present, use it; otherwise default to Sastra
                const domain = c.domain || 'webstream.sastra.edu';
                const path = c.path || '/';
                
                // Construct a tough-cookie compatible string
                const cookieString = `${c.name}=${c.value}; Domain=${domain}; Path=${path}`;
                
                // Set the cookie for the specific URL
                jar.setCookieSync(cookieString, "https://webstream.sastra.edu");
            } catch (e) {
                console.error("Skipping invalid cookie:", c.name);
            }
        });
    }

    // Create the client wrapped with cookie support
    // REMOVED 'httpsAgent' to fix the conflict error
    const client = wrapper(axios.create({
        baseURL: "https://webstream.sastra.edu/sastrapwi/",
        jar, 
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Connection": "keep-alive" 
        },
        timeout: 25000 // 25s timeout to be safe
    }));

    return client;
};