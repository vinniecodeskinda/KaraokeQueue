# YouTube Data API quota extension: application for Karaoke Queue

- **Form:** https://support.google.com/youtube/contact/yt_api_form ("YouTube Data API Services – Audit and Quota Extension Form")
- **Current quota:** 10,000 units/day (Google's default). `search.list` costs 100 units, so that's about **100 searches/day** shared by every user of the app.
- **Requesting:** 50,000 units/day, used only for `search.list` (about 500 searches/day).

Answers are in form order. **[FILL IN]** marks personal details only you can provide.

---

## Before you submit: things the form requires

1. **Privacy Policy page:** required (URL + screenshots). The app doesn't have one yet.
2. **Terms of Service:** required as an upload (image or PDF). The app doesn't have one yet.
3. **Homepage screenshot** showing where the Privacy Policy link is, with YouTube branding visible.
4. **Player/embed screenshots:** the TV screen with the YouTube player.
5. **Google Cloud project *number*:** digits, not the project ID `karaoke-queue-512310`. It's on the Cloud Console dashboard, "Project info" card.
6. **Optional but recommended:** an architecture diagram and a user-flow diagram (image or PDF).

Every screenshot must be at least 1280×720, sharp, include the browser address bar, and be under 10 MB.

---

## Section 1: Request type

**Complete a compliance audit to request for additional quota**

## Section 2: Organization and contact information

| Field | Answer |
|---|---|
| Are you applying | As an individual user |
| Your Full Legal Name | **[FILL IN]** |
| Organization's Legal Name | self |
| Parent Company Name | self |
| Organization's Primary Website | https://karaokequeue.pages.dev |
| Address (Country, Street, City, State, Postal Code) | **[FILL IN]** (your own contact address) |
| Category | Entertainment (or the closest available option) |
| Organization Size / Type | Independent Developer/Sole Proprietor |
| Primary Contact Name / Email | **[FILL IN]** / **[FILL IN]** |
| Technical / Business contact | Same as Primary Contact |

## Section 3: Business model and Google contacts

**Describe your organization's work as it relates to YouTube** (max 5,000 characters):

> Karaoke Queue (https://karaokequeue.pages.dev) is a free, non-commercial web app for home karaoke parties, built and run by an independent developer. One screen (usually a TV or laptop) hosts a "room" and plays karaoke and lyric videos through the official YouTube IFrame Player embed. Guests join the room from their phones by scanning a QR code or entering a 5-character room code. No sign-in or account is needed.
>
> Guests use the YouTube Data API v3 `search.list` endpoint to find a karaoke version of the song they want to sing, then add it to a shared, real-time queue. When a song finishes, the host screen plays the next video in the queue through the YouTube embedded player. All playback happens inside the official YouTube player, with YouTube's branding, controls and ads left intact. We never download, rip, re-host or modify YouTube audio or video, and we don't block or skip ads.
>
> Value to users and to YouTube: the app turns a living room into a karaoke night using karaoke channels' existing YouTube uploads. Every song sung is a full view of a YouTube karaoke video (from channels such as Sing King, Zoom Karaoke, KaraFun and many independent karaoke creators) through the official embed. It drives views and watch time to karaoke creators, who exist on YouTube for exactly this purpose.
>
> How we use the API:
> - Endpoint: only `search.list` (part=snippet, type=video, videoEmbeddable=true, safeSearch=moderate), so we only show videos whose owners allow embedding.
> - Searches run only when a user explicitly presses Search, never on every keystroke.
> - Calls go through a server-side function so the API key is never exposed in the browser.
> - Responses are cached server-side for 7 days (Cloudflare Workers KV, deleted automatically when they expire, well within the 30-day limit in the Developer Policies), so repeated searches for the same song (very common at karaoke parties) don't use additional quota. Changing a display setting re-sorts results already on screen instead of searching again.
> - We display the video title, channel name and thumbnail only to help the user choose. When a video is picked, we keep its video ID, title and channel name so the queue can show "Up next: <singer> — <song>". This data is deleted within 30 days.
>
> Why we need more quota: each search costs 100 units, so the default 10,000 units/day allows only about 100 searches per day across all users. A single party of 20–30 guests can use most of that in an evening, and the app serves multiple independent parties. We're requesting 50,000 units/day for `search.list` (about 500 searches/day). We don't use any other endpoints.

**Who is your target audience:** General Public

**How does your API Client monetize:** Free service (we do not charge users). The app has no ads, subscriptions or paid features.

**Google Partner Manager:** No, I do not have a Google representative

**How did you first learn about the YouTube Data API:** pick the closest option (for example "Google search" or "Documentation").

**Content Owner ID(s) / Google Ads Customer ID(s):** leave blank (not applicable).

## Section 4: API client overview and access information

| Field | Answer |
|---|---|
| API Client Name | Karaoke Queue |
| Does the name contain "YouTube"? | No, the name does not contain "YouTube" |
| Primary Access URL | https://karaokequeue.pages.dev |
| Privacy Policy URL | https://karaokequeue.pages.dev/privacy/ *(page needs to be created first)* |
| Terms of Service URL | https://karaokequeue.pages.dev/terms/ *(page needs to be created first)* |
| Is your API Client publicly accessible? | Yes |

## Section 5: Use cases and quota extension details

| Field | Answer |
|---|---|
| How many project numbers | 1 |
| Google Cloud Project Number | **[FILL IN]**: the digits from the Cloud Console "Project info" card for project *Karaoke Queue* (`karaoke-queue-512310`) |
| Use Case Category | **Websites & Mobile Apps** (embedding YouTube videos in a web app). Also tick **Smart TVs, Consoles & Hardware** if you want to, since the host screen is usually a TV browser. |
| Requires Google sign-in (OAuth 2.0)? | No |
| Expected API Usage Volume | Pick the band that covers **50,000 units/day** |
| Endpoints used | **search.list** only |
| Total quota requested | Above Default quota |
| search.list quota (asked separately) | **50,000 units/day** (about 500 searches/day) |

**Required evidence uploads (Project #1):**
- **Privacy Policy screenshots:** the privacy page, showing the YouTube API Services section, the link to Google's Privacy Policy, and the data deletion section.
- **Homepage screenshot:** https://karaokequeue.pages.dev with the footer's Privacy Policy link visible, plus visible YouTube branding (for example, a search result list or the TV screen with the YouTube player).
- **Terms of Service documentation:** a PDF or screenshot of the terms page.
- **Player/Embed screenshots:** the TV (host) screen playing a karaoke video in the YouTube embedded player, with the address bar visible.

## Section 6: Additional evidence (optional but recommended)

- **Architecture diagram:**
  Phone browser → Cloudflare Pages Function (holds the API key, 7-day KV cache) → YouTube Data API `search.list`.
  Host browser → official YouTube IFrame Player (video playback).
  Queue/rooms → Supabase database.
- **User flow diagram:** Host creates room → guests scan QR → guest searches → picks karaoke video → queued → TV plays it in the YouTube embed → next song.

## Section 7: Attestations

Read and tick each box yourself. They're legal agreements, so only you can agree to them.

---

## Expected outcome

Google reviews these by hand. Reviews often take several weeks, and they may email follow-up questions. While waiting, the app keeps working on the default 100 searches/day.
