// The one data API every page uses. Picks the real Supabase backend when
// SUPABASE_URL / SUPABASE_ANON_KEY are set, otherwise an in-browser demo
// backend so the app can be tried with zero setup.
import { isConfigured } from './supabase.js';
import * as supabaseBackend from './backend-supabase.js';
import * as demoBackend from './backend-demo.js';

export const isDemo = !isConfigured;
const impl = isDemo ? demoBackend : supabaseBackend;

export const createRoom = (...a) => impl.createRoom(...a);
export const findRoom = (...a) => impl.findRoom(...a);
export const fetchActiveQueue = (...a) => impl.fetchActiveQueue(...a);
export const searchSongs = (...a) => impl.searchSongs(...a);
export const requestSong = (...a) => impl.requestSong(...a);
export const requestYoutubeSong = (...a) => impl.requestYoutubeSong(...a);
export const advanceQueue = (...a) => impl.advanceQueue(...a);
export const searchYoutube = (...a) => impl.searchYoutube(...a);
export const subscribeToQueue = (...a) => impl.subscribeToQueue(...a);
