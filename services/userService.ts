import { supabase } from '../services/api';

// Fetch all users
export const getAllUsers = async () => {
  const { data, error } = await supabase.from('users').select('*');
  if (error) throw new Error(error.message);
  return data;
};

// Fetch a single user by ID
export const getUserById = async (userId: string) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) throw new Error(error.message);
  return data;
};

// Add a new user
export const addUser = async (user: { name: string; email: string }) => {
  const { data, error } = await supabase.from('users').insert(user);
  if (error) throw new Error(error.message);
  return data;
};