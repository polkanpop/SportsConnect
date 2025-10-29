
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const api = axios.create({
  baseURL: 'http://localhost:8000/api', // FastAPI
  timeout: 10000,
});

// Add auth token automatically
supabase.auth.onAuthStateChange((event, session) => {
  if (session?.access_token) {
    api.defaults.headers.common['Authorization'] = `Bearer ${session.access_token}`;
  }
});