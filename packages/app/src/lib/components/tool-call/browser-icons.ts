import AppWindowIcon from "@lucide/svelte/icons/app-window";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import BracesIcon from "@lucide/svelte/icons/braces";
import CameraIcon from "@lucide/svelte/icons/camera";
import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
import FileCodeIcon from "@lucide/svelte/icons/file-code";
import GlobeIcon from "@lucide/svelte/icons/globe";
import HourglassIcon from "@lucide/svelte/icons/hourglass";
import KeyboardIcon from "@lucide/svelte/icons/keyboard";
import MonitorIcon from "@lucide/svelte/icons/monitor";
import MousePointerIcon from "@lucide/svelte/icons/mouse-pointer";
import MousePointerClickIcon from "@lucide/svelte/icons/mouse-pointer-click";
import MoveVerticalIcon from "@lucide/svelte/icons/move-vertical";
import NetworkIcon from "@lucide/svelte/icons/network";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import ScalingIcon from "@lucide/svelte/icons/scaling";
import ScanTextIcon from "@lucide/svelte/icons/scan-text";
import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
import TextCursorInputIcon from "@lucide/svelte/icons/text-cursor-input";

/** One icon per browser tool; anything new falls back on the monitor. */
const ICONS: Record<string, typeof GlobeIcon> = {
  navigate: GlobeIcon,
  back: ArrowLeftIcon,
  forward: ArrowRightIcon,
  reload: RotateCwIcon,
  snapshot: ScanTextIcon,
  click: MousePointerClickIcon,
  hover: MousePointerIcon,
  type: TextCursorInputIcon,
  press_key: KeyboardIcon,
  select_option: ChevronsUpDownIcon,
  scroll: MoveVerticalIcon,
  wait_for: HourglassIcon,
  screenshot: CameraIcon,
  evaluate: BracesIcon,
  add_init_script: FileCodeIcon,
  console_messages: SquareTerminalIcon,
  network_requests: NetworkIcon,
  tabs: AppWindowIcon,
  resize: ScalingIcon,
};

export function browserToolIcon(tool: string): typeof GlobeIcon {
  return ICONS[tool] ?? MonitorIcon;
}
