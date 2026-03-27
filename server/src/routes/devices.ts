import { Router } from 'express';
import type { OutputDevice } from '@audioserver/shared';

export const devicesRouter = Router();

// For now, return a mock browser device. Real DLNA/Sonos discovery comes later.
const mockDevices: OutputDevice[] = [
  {
    id: 'browser',
    name: 'This Browser',
    type: 'browser',
    isOnline: true,
  },
  {
    id: 'cocktail-mock',
    name: 'Cocktail Audio (mock)',
    type: 'dlna',
    host: '192.168.1.100',
    isOnline: false,
  },
  {
    id: 'volumio-mock',
    name: 'Volumio (mock)',
    type: 'volumio',
    host: '192.168.1.101',
    isOnline: false,
  },
  {
    id: 'sonos-mock',
    name: 'Sonos Living Room (mock)',
    type: 'sonos',
    host: '192.168.1.102',
    isOnline: false,
  },
];

devicesRouter.get('/', (_req, res) => {
  res.json({ data: mockDevices });
});

devicesRouter.get('/:id', (req, res) => {
  const device = mockDevices.find((d) => d.id === req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  res.json({ data: device });
});
