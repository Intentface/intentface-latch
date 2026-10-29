/**
 * The people you can switch between. A real app gets its principal from its
 * login; here the browser names one of these, and anything else is refused.
 */
export type Principal = { orgId: string; userId: string; staff?: boolean };

export interface Person {
  id: string;
  name: string;
  role: string;
  org: { id: string; name: string };
  principal: Principal;
}

const NORTHWIND = { id: "northwind", name: "Northwind Freight" };
const BRIGHTSIDE = { id: "brightside", name: "Brightside Clinics" };

export const PEOPLE: Person[] = [
  { id: "maija", name: "Maija Virtanen", role: "Product lead", org: NORTHWIND, principal: { orgId: "northwind", userId: "maija" } },
  { id: "jussi", name: "Jussi Laine", role: "Engineer", org: NORTHWIND, principal: { orgId: "northwind", userId: "jussi" } },
  { id: "omar", name: "Omar Haddad", role: "Designer", org: BRIGHTSIDE, principal: { orgId: "brightside", userId: "omar" } },
  {
    id: "sara",
    name: "Sara Lind",
    role: "Advisor, our staff",
    org: NORTHWIND,
    principal: { orgId: "northwind", userId: "sara", staff: true },
  },
];

export const ORGS = [NORTHWIND, BRIGHTSIDE];

export const personOf = (request: Request) => PEOPLE.find((p) => p.id === request.headers.get("x-demo-person"));
