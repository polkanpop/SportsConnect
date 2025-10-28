import type { NextApiRequest, NextApiResponse } from 'next';
import { getAllUsers, getUserById, addUser } from '../services/userService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      // Fetch all users
      const users = await getAllUsers();
      res.status(200).json(users);
    } else if (req.method === 'POST') {
      // Add a new user
      const { name, email } = req.body;
      const newUser = await addUser({ name, email });
      res.status(201).json(newUser);
    } else {
      res.status(405).json({ message: 'Method not allowed' });
    }
  } catch (error) {
      if (error instanceof Error) {
        res.status(500).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'An unknown error occurred' });
      }
}
}