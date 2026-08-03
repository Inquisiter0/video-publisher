# Video Publisher - TODO List & Roadmap

## High Priority Tasks for Tomorrow:

- [ ] **Video Duration & Format Constraints (YouTube Shorts vs Instagram Reels)**
  - **YouTube Shorts Limit (180s / 3 mins)**:
    - If video duration is $\le 180$ seconds (3 minutes), publish as a **YouTube Short**.
    - If video duration is $> 180$ seconds, prompt the user with a warning: *"Video exceeds 180 seconds (3 mins). It will be published as a standard YouTube video instead of a YouTube Short."*
  - **Instagram Reels Limit (up to 15 mins)**:
    - Instagram Reels support videos up to 15 minutes.
  - **Vertical Aspect Ratio Validation**:
    - Ensure input videos are verified for 9:16 vertical aspect ratio (or auto center-cropped to 1080x1920 via FFmpeg).

- [ ] **Google OAuth Setup**
  - Obtain `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from Google Cloud Console.
  - Test end-to-end "Connect YouTube" button flow from the dashboard.

- [ ] **Instagram Setup (Optional)**
  - Add Meta Graph API credentials when ready for live Instagram Reels testing.
