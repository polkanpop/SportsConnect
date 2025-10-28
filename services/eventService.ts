import { supabase } from '../services/api';

// Fetch all events
export const getAllEvents = async () => {
  const { data, error } = await supabase.from('events').select('*');
  if (error) throw new Error(error.message);
  return data;
};

// Fetch an event by ID
export const getEventById = async (eventId: string) => {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('id', eventId)
    .single();
  if (error) throw new Error(error.message);
  return data;
};

// Add a new event
export const addEvent = async (event: { name: string; date: string }) => {
  const { data, error } = await supabase.from('events').insert(event);
  if (error) throw new Error(error.message);
  return data;
};