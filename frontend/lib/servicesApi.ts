export type ServiceCategory = 'consumable' | 'rental'
export type ServiceStatus = 'active' | 'inactive'

export type ServiceRow = {
  serviceid: number
  courtid: number
  name: string
  category: ServiceCategory
  price: number
  stock: number
  images: string[]
  status: ServiceStatus
}

const SERVICE_TEMPLATES: Array<Omit<ServiceRow, 'serviceid' | 'courtid'>> = [
  {
    name: 'Khăn lạnh',
    category: 'consumable',
    price: 5000,
    stock: 100,
    images: ['https://res.cloudinary.com/dg0rerv5b/image/upload/v1772706691/kae1ibi5ldfpjdcpnqgh.png'],
    status: 'active',
  },
  {
    name: 'Revive',
    category: 'consumable',
    price: 15000,
    stock: 100,
    images: ['https://res.cloudinary.com/dg0rerv5b/image/upload/v1772706692/gfa8ffjpdk7dpqxf4jc1.png'],
    status: 'active',
  },
  {
    name: 'Revive chanh muối',
    category: 'consumable',
    price: 15000,
    stock: 100,
    images: ['https://res.cloudinary.com/dg0rerv5b/image/upload/v1772706692/msqrr5c44vbj4aomxbph.png'],
    status: 'active',
  },
  {
    name: 'Pocari Sweat',
    category: 'consumable',
    price: 20000,
    stock: 100,
    images: ['https://res.cloudinary.com/dg0rerv5b/image/upload/v1772706692/zds9hubggmgytaqsgij5.png'],
    status: 'active',
  },
  {
    name: 'Trà đá',
    category: 'consumable',
    price: 5000,
    stock: 100,
    images: ['https://res.cloudinary.com/dg0rerv5b/image/upload/v1772706693/p89rxzf3hyhpfhpepsmu.png'],
    status: 'active',
  },
]

function makeServiceId(courtid: number, indexInCourt: number) {
  // courtid 101 => base 0, index 0..4 => ids 1..5
  const base = Math.max(0, courtid - 101) * SERVICE_TEMPLATES.length
  return base + indexInCourt + 1
}

// Fake fetch for now (no backend config yet)
export async function listServicesByCourtId(courtid: number): Promise<ServiceRow[]> {
  if (!Number.isFinite(courtid)) return []
  // Seeded dataset exists only for courtid 101–130.
  if (courtid < 101 || courtid > 130) return []
  return SERVICE_TEMPLATES.map((tpl, idx) => ({
    serviceid: makeServiceId(courtid, idx),
    courtid,
    ...tpl,
  }))
}
