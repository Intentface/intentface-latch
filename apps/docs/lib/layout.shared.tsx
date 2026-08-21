import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

/** Chrome shared by every layout (nav title, links). */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: "Latch" },
    links: [
      {
        text: "GitHub",
        url: "https://github.com/Intentface/intentface-latch",
        external: true,
      },
    ],
  };
}
