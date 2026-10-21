import type { Person } from "./api";

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);

/** Switch who you are. Each person is a different principal: their org, their notes, their chats. */
export function PeoplePicker({ people, selected, onSelect }: { people: Person[]; selected: string; onSelect: (id: string) => void }) {
  const orgs = [...new Set(people.map((p) => p.org.name))];
  return (
    <section className="people" aria-label="Signed in as">
      <h2 className="section-title">Signed in as</h2>
      {orgs.map((org) => (
        <div key={org} className="people-org">
          <div className="people-org-name">{org}</div>
          <ul>
            {people
              .filter((p) => p.org.name === org)
              .map((p) => (
                <li key={p.id}>
                  <button type="button" className="person" aria-pressed={p.id === selected} onClick={() => onSelect(p.id)}>
                    <span className="avatar" data-staff={p.principal.staff ? "" : undefined}>
                      {initials(p.name)}
                    </span>
                    <span className="person-text">
                      <span className="person-name">{p.name}</span>
                      <span className="person-role">{p.role}</span>
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
