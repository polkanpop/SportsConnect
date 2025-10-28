import type { NextApiRequest, NextApiResponse } from 'next';
import { getAllEvents, getEventById, addEvent } from '../services/eventService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      // Fetch all events
      const events = await getAllEvents();
      res.status(200).json(events);
    } else if (req.method === 'POST') {
      // Add a new event
      const { name, date } = req.body;
      const newEvent = await addEvent({ name, date });
      res.status(201).json(newEvent);
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