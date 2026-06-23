import type { SVGProps } from "react";

export function SendIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M20.9021 5.2869C21.3196 3.9415 20.0574 2.6793 18.712 3.09684L2.18837 8.22487C0.498062 8.74945 0.565609 11.1647 2.28263 11.594L10.235 13.5821C10.3245 13.6045 10.3945 13.6744 10.4169 13.764L12.4049 21.7163C12.8342 23.4333 15.2495 23.5009 15.7741 21.8106L20.9021 5.2869Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

export function StopIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor" />
    </svg>
  );
}

export function PaperClipIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M5.75 10.75V15.25C5.75 18.5637 8.43629 21.25 11.75 21.25H12.25C15.5637 21.25 18.25 18.5637 18.25 15.25V7C18.25 4.65279 16.3472 2.75 14 2.75C11.6528 2.75 9.75 4.65279 9.75 7V14.875C9.75 16.0486 10.7014 17 11.875 17C13.0486 17 14 16.0486 14 14.875V7.75"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        ></path>
      </g>
    </svg>
  );
}

export const ChevronDownIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <g>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.1768 12.7625C12.0791 12.8601 11.9209 12.8601 11.8232 12.7625L8.53033 9.46958C8.23744 9.17668 7.76256 9.17668 7.46967 9.46958C7.17678 9.76247 7.17678 10.2373 7.46967 10.5302L10.7626 13.8231C11.446 14.5065 12.554 14.5065 13.2374 13.8231L16.5303 10.5302C16.8232 10.2373 16.8232 9.76247 16.5303 9.46958C16.2374 9.17668 15.7626 9.17668 15.4697 9.46958L12.1768 12.7625Z"
        fill="currentColor"
      />
    </g>
  </svg>
);

export const CheckMarkMediumIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <g>
      <path
        d="M6 14.15L10.0321 18L18 7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
);

export const BrainIcon = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M5.95106 4.60361L7.71846 3.49898C8.47729 3.02472 9.40821 2.91395 10.2571 3.19693L11.0513 3.46166C11.6671 3.66692 12.3329 3.66692 12.9487 3.46166L13.7429 3.19693C14.5918 2.91396 15.5227 3.02472 16.2815 3.49898L18.0489 4.60361C18.7615 5.04899 19.1944 5.83005 19.1944 6.67038C19.1944 7.43752 19.5556 8.15988 20.1693 8.62016L20.2222 8.65983C20.8692 9.14508 21.25 9.90663 21.25 10.7154V12.2571C21.25 13.0658 20.8692 13.8274 20.2222 14.3126C19.5752 14.7979 19.1944 15.5594 19.1944 16.3682V17.0179C19.1944 18.0523 18.6616 19.0137 17.7844 19.5619L16.2815 20.5012C15.5227 20.9755 14.5918 21.0863 13.7429 20.8033L12.9487 20.5386C12.3329 20.3333 11.6671 20.3333 11.0513 20.5386L10.2571 20.8033C9.40822 21.0863 8.47729 20.9755 7.71846 20.5012L6.21556 19.5619C5.33841 19.0137 4.80556 18.0523 4.80556 17.0179V16.3682C4.80556 15.5594 4.42478 14.7979 3.77778 14.3126C3.13078 13.8274 2.75 13.0658 2.75 12.2571V10.7154C2.75 9.90663 3.13078 9.14508 3.77778 8.65983L3.83066 8.62016C4.44437 8.15988 4.80556 7.43752 4.80556 6.67038C4.80556 5.83005 5.23846 5.04899 5.95106 4.60361Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 4V6.75736C12 7.55301 12.3161 8.31607 12.8787 8.87868L15 11"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 20V17.2426C12 16.447 11.6839 15.6839 11.1213 15.1213L9 13"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx="9"
          cy="13"
          r="1"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx="15"
          cy="11"
          r="1"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
};

export const BubbleWideSparkleIcon = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M12.75 3.75H5.75C4.09315 3.75 2.75 5.09315 2.75 6.75V15.25C2.75 16.9069 4.09315 18.25 5.75 18.25H8.65182C8.88675 18.25 9.11418 18.3327 9.29422 18.4836L11.3593 20.2147C11.7292 20.5248 12.2679 20.5263 12.6397 20.2183L14.738 18.4799C14.9173 18.3313 15.143 18.25 15.3759 18.25H18.25C19.9069 18.25 21.25 16.9069 21.25 15.25V12.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M20.2405 4.18518L19.5436 2.37334C19.4571 2.14842 19.241 2 19 2C18.759 2 18.5429 2.14842 18.4564 2.37334L17.7595 4.18518C17.658 4.44927 17.4493 4.65797 17.1852 4.75955L15.3733 5.45641C15.1484 5.54292 15 5.75901 15 6C15 6.24099 15.1484 6.45708 15.3733 6.54359L17.1852 7.24045C17.4493 7.34203 17.658 7.55073 17.7595 7.81482L18.4564 9.62666C18.5429 9.85158 18.759 10 19 10C19.241 10 19.4571 9.85158 19.5436 9.62666L20.2405 7.81482C20.342 7.55073 20.5507 7.34203 20.8148 7.24045L22.6267 6.54359C22.8516 6.45708 23 6.24099 23 6C23 5.75901 22.8516 5.54292 22.6267 5.45641L20.8148 4.75955C20.5507 4.65797 20.342 4.44927 20.2405 4.18518Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
};

export const CodeIcon = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M10.25 9L7.95711 11.2929C7.56658 11.6834 7.56658 12.3166 7.95711 12.7071L10.25 15M13.75 9L16.0429 11.2929C16.4334 11.6834 16.4334 12.3166 16.0429 12.7071L13.75 15M6.75 20.25H17.25C18.9069 20.25 20.25 18.9069 20.25 17.25V6.75C20.25 5.09315 18.9069 3.75 17.25 3.75H6.75C5.09315 3.75 3.75 5.09315 3.75 6.75V17.25C3.75 18.9069 5.09315 20.25 6.75 20.25Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
};

export const FileChartIcon = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M11.9216 2.75H7.75C6.09315 2.75 4.75 4.09315 4.75 5.75V18.25C4.75 19.9069 6.09315 21.25 7.75 21.25H16.25C17.9069 21.25 19.25 19.9069 19.25 18.25V10.0784C19.25 9.54799 19.0393 9.03929 18.6642 8.66421L13.3358 3.33579C12.9607 2.96071 12.452 2.75 11.9216 2.75Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M12.75 3.25V7.25C12.75 8.35457 13.6454 9.25 14.75 9.25H18.75"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M8.5 17.25V15.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M12 17.25V12.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M15.5 17.25V14.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    </svg>
  );
};

export const FileTextIcon = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M11.9216 2.75H7.75C6.09315 2.75 4.75 4.09315 4.75 5.75V18.25C4.75 19.9069 6.09315 21.25 7.75 21.25H16.25C17.9069 21.25 19.25 19.9069 19.25 18.25V10.0784C19.25 9.54799 19.0393 9.03929 18.6642 8.66421L13.3358 3.33579C12.9607 2.96071 12.452 2.75 11.9216 2.75Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M12.75 3.25V7.25C12.75 8.35457 13.6454 9.25 14.75 9.25H18.75"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M8.75 13.25H12.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M8.75 17.25H15.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    </svg>
  );
};

export const GlobeIcon = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M12 2.75C12 2.75 16.25 6.5 16.25 12C16.25 17.5 12 21.25 12 21.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 2.75C12 2.75 7.75 6.5 7.75 12C7.75 17.5 12 21.25 12 21.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M3.25 12H20.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    </svg>
  );
};

export const ImageAltIcon = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M6.75 17.25H12.25M15.25 17.25H17.25M20.25 14.25V6.75C20.25 5.09315 18.9069 3.75 17.25 3.75H6.75C5.09315 3.75 3.75 5.09315 3.75 6.75V12.0577M20.25 14.25V17.25C20.25 18.9069 18.9069 20.25 17.25 20.25H6.75C5.09315 20.25 3.75 18.9069 3.75 17.25V14.25M20.25 14.25H14.2767M3.75 14.25V12.0577M3.75 14.25H14.2767M3.75 12.0577L5.80016 9.95496C6.97827 8.74664 8.92087 8.74747 10.098 9.9568L14.2767 14.25M17.25 8.25C17.25 9.07843 16.5784 9.75 15.75 9.75C14.9216 9.75 14.25 9.07843 14.25 8.25C14.25 7.42157 14.9216 6.75 15.75 6.75C16.5784 6.75 17.25 7.42157 17.25 8.25Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
};

export const SpreadsheetIcon = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg
      aria-hidden="true"
      width="24px"
      height="24px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M19.923 5.38803L19.2548 5.72852V5.72852L19.923 5.38803ZM18.612 4.07698L18.9525 3.40873V3.40873L18.612 4.07698ZM5.38803 4.07698L5.72852 4.74524V4.74524L5.38803 4.07698ZM4.07698 5.38803L4.74524 5.72852V5.72852L4.07698 5.38803ZM4.07698 18.612L3.40873 18.9525H3.40873L4.07698 18.612ZM5.38803 19.923L5.72852 19.2548H5.72852L5.38803 19.923ZM18.612 19.923L18.2715 19.2548H18.2715L18.612 19.923ZM19.923 18.612L19.2548 18.2715V18.2715L19.923 18.612ZM20.25 8.55H19.5V15.45H20.25H21V8.55H20.25ZM20.25 8.55H21C21 7.7223 21.0006 7.05641 20.9566 6.51853C20.912 5.97189 20.8176 5.49175 20.5913 5.04754L19.923 5.38803L19.2548 5.72852C19.3554 5.92604 19.4245 6.1868 19.4616 6.64068C19.4994 7.10331 19.5 7.69755 19.5 8.55H20.25ZM19.923 5.38803L20.5913 5.04754C20.2318 4.34193 19.6581 3.76825 18.9525 3.40873L18.612 4.07698L18.2715 4.74524C18.6948 4.96095 19.0391 5.30516 19.2548 5.72852L19.923 5.38803ZM15.45 3.75V4.5C16.3025 4.5 16.8967 4.50058 17.3593 4.53838C17.8132 4.57546 18.074 4.6446 18.2715 4.74524L18.612 4.07698L18.9525 3.40873C18.5082 3.18238 18.0281 3.08803 17.4815 3.04336C16.9436 2.99942 16.2777 3 15.45 3V3.75ZM8.55 3.75V4.5H15.45V3.75V3H8.55V3.75ZM8.55 3.75V3C7.7223 3 7.05641 2.99942 6.51853 3.04336C5.97189 3.08803 5.49175 3.18238 5.04754 3.40873L5.38803 4.07698L5.72852 4.74524C5.92604 4.6446 6.1868 4.57546 6.64068 4.53838C7.10331 4.50058 7.69755 4.5 8.55 4.5V3.75ZM4.07698 5.38803L4.74524 5.72852C4.96095 5.30516 5.30516 4.96095 5.72852 4.74524L5.38803 4.07698L5.04754 3.40873C4.34193 3.76825 3.76825 4.34193 3.40873 5.04754L4.07698 5.38803ZM3.75 8.55H4.5C4.5 7.69755 4.50058 7.10331 4.53838 6.64068C4.57546 6.1868 4.6446 5.92604 4.74524 5.72852L4.07698 5.38803L3.40873 5.04754C3.18238 5.49175 3.08803 5.97189 3.04336 6.51853C2.99942 7.05641 3 7.7223 3 8.55H3.75ZM3.75 15.45H4.5V8.55H3.75H3V15.45H3.75ZM3.75 15.45H3C3 16.2777 2.99942 16.9436 3.04336 17.4815C3.08803 18.0281 3.18238 18.5082 3.40873 18.9525L4.07698 18.612L4.74524 18.2715C4.6446 18.074 4.57546 17.8132 4.53838 17.3593C4.50058 16.8967 4.5 16.3025 4.5 15.45H3.75ZM5.38803 19.923L5.72852 19.2548C5.30516 19.0391 4.96095 18.6948 4.74524 18.2715L4.07698 18.612L3.40873 18.9525C3.76825 19.6581 4.34193 20.2318 5.04754 20.5913L5.38803 19.923ZM8.55 20.25V19.5C7.69755 19.5 7.10331 19.4994 6.64068 19.4616C6.1868 19.4245 5.92604 19.3554 5.72852 19.2548L5.38803 19.923L5.04754 20.5913C5.49175 20.8176 5.97189 20.912 6.51853 20.9566C7.05641 21.0006 7.7223 21 8.55 21V20.25ZM15.45 20.25V19.5H8.55V20.25V21H15.45V20.25ZM15.45 20.25V21C16.2777 21 16.9436 21.0006 17.4815 20.9566C18.0281 20.912 18.5082 20.8176 18.9525 20.5913L18.612 19.923L18.2715 19.2548C18.074 19.3554 17.8132 19.4245 17.3593 19.4616C16.8967 19.4994 16.3025 19.5 15.45 19.5V20.25ZM19.923 18.612L19.2548 18.2715C19.0391 18.6948 18.6948 19.0391 18.2715 19.2548L18.612 19.923L18.9525 20.5913C19.6581 20.2318 20.2318 19.6581 20.5913 18.9525L19.923 18.612ZM20.25 15.45H19.5C19.5 16.3025 19.4994 16.8967 19.4616 17.3593C19.4245 17.8132 19.3554 18.074 19.2548 18.2715L19.923 18.612L20.5913 18.9525C20.8176 18.5082 20.912 18.0281 20.9566 17.4815C21.0006 16.9436 21 16.2777 21 15.45H20.25Z"
          fill="currentColor"
        />
        <path
          d="M9.75 3.75V9.75V20.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
        />
        <path
          d="M3.75 9.75H9.75H20.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
        />
      </g>
    </svg>
  );
};
