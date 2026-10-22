import { Nav } from "@intentface/chat/nav";
import { ChevronDown } from "@keyline-icons/react";
import type { Person } from "./api";
import { NAV_LIST, NAV_ROW } from "./ui";

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("");

const groupOf = (p: Person) => (p.principal.staff ? `Our staff, in ${p.org.name}` : p.org.name);

/** Who you are. Each person is a different principal: their org, their notes, their chats. */
export function PeopleNav({ people, selected, onSelect }: { people: Person[]; selected: string; onSelect: (id: string) => void }) {
  const groups = [...new Set(people.map(groupOf))];
  return (
    <Nav.Root aria-label="Signed in as" guide="none" defaultExpanded={groups} render={<nav />} className="people-nav flex flex-col gap-0.5 px-2">
      <Nav.List className={NAV_LIST}>
        {groups.map((group) => (
          <Nav.Group key={group} value={group}>
            <Nav.Trigger className={`${NAV_ROW} text-zinc-500 dark:text-zinc-400`}>
              <Nav.Label className="min-w-0 truncate text-[12px]">{group}</Nav.Label>
              <ChevronDown className="ml-auto !size-3 text-zinc-400 transition-transform group-data-[closed]/row:-rotate-90 dark:text-zinc-500" />
            </Nav.Trigger>
            <Nav.List className={NAV_LIST}>
              {people
                .filter((p) => groupOf(p) === group)
                .map((p) => (
                  <Nav.Item key={p.id} value={p.id} active={p.id === selected} onClick={() => onSelect(p.id)} className={NAV_ROW} title={p.role}>
                    <Nav.Icon>
                      <span
                        className={`grid size-5 place-items-center rounded-full text-[9px] font-semibold ${
                          p.principal.staff
                            ? "bg-emerald-600/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300"
                            : "bg-zinc-950/6 text-zinc-600 dark:bg-white/10 dark:text-zinc-300"
                        }`}
                      >
                        {initials(p.name)}
                      </span>
                    </Nav.Icon>
                    <Nav.Label className="min-w-0 truncate">{p.name}</Nav.Label>
                    <span className="ml-auto truncate text-[11px] font-normal text-zinc-400 dark:text-zinc-500">{p.role.split(",")[0]}</span>
                  </Nav.Item>
                ))}
            </Nav.List>
          </Nav.Group>
        ))}
      </Nav.List>
    </Nav.Root>
  );
}
