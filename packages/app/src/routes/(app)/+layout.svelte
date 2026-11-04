<script lang="ts">
import { can, type Capability } from "$lib/utils/auth/capabilities";
import { browser } from "$app/environment";
import { afterNavigate, goto, onNavigate } from "$app/navigation";
import { page } from "$app/state";
import type { TaskPage } from "$lib/api/types";
import { LiveTaskList, setTaskListContext } from "$lib/components/task-list/live-task-list.svelte";
import * as Avatar from "$lib/components/ui/avatar";
import { personInitials } from "$lib/utils/avatar";
import TaskListPane from "$lib/components/task-list-pane/task-list-pane.svelte";
import * as Breadcrumb from "$lib/components/ui/breadcrumb";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import { Separator } from "$lib/components/ui/separator";
import * as Sidebar from "$lib/components/ui/sidebar";
import { SIDEBAR_COOKIE_MAX_AGE, SIDEBAR_COOKIE_NAME } from "$lib/components/ui/sidebar/constants";
import { IsMobile } from "$lib/hooks/is-mobile.svelte.js";
import { pageHeader } from "$lib/components/page-header/page-header.svelte";
import { logOut } from "$lib/utils/auth/auth";
import RyphLogo, { excite } from "$lib/components/ryph-logo/ryph-logo.svelte";
import AppWindowIcon from "@lucide/svelte/icons/app-window";
import BookOpenTextIcon from "@lucide/svelte/icons/book-open-text";
import BotIcon from "@lucide/svelte/icons/bot";
import BrainIcon from "@lucide/svelte/icons/brain";
import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
import CircleCheckBigIcon from "@lucide/svelte/icons/circle-check-big";
import ContainerIcon from "@lucide/svelte/icons/container";
import FolderGit2Icon from "@lucide/svelte/icons/folder-git-2";
import GitPullRequestIcon from "@lucide/svelte/icons/git-pull-request";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import LayersIcon from "@lucide/svelte/icons/layers";
import ListChecksIcon from "@lucide/svelte/icons/list-checks";
import LogOutIcon from "@lucide/svelte/icons/log-out";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import PlugIcon from "@lucide/svelte/icons/plug";
import ServerCogIcon from "@lucide/svelte/icons/server-cog";
import SettingsIcon from "@lucide/svelte/icons/settings";
import ShieldIcon from "@lucide/svelte/icons/shield";
import UsersIcon from "@lucide/svelte/icons/users";
import ZapIcon from "@lucide/svelte/icons/zap";
import DetailsPaneHost from "$lib/components/details-pane/details-pane-host.svelte";
import {
  DETAILS_PANE_INITIAL,
  DETAILS_PANE_MAX,
  DETAILS_PANE_MIN,
  detailsPane,
} from "$lib/components/details-pane/details-pane.svelte";
import RailFlyoutCard from "$lib/components/rail-flyout/rail-flyout.svelte";
import { RailFlyout } from "$lib/components/rail-flyout/flyout-state.svelte";
import { viewTransitionFinished } from "$lib/utils/view-transition";
import { untrack } from "svelte";
import type { LayoutProps } from "./$types";

let { data, children }: LayoutProps = $props();

// Remembered across visits in the sidebar's own cookie. The server reads it to render the first
// page folded or not; in the browser it is read again whenever this layout mounts — coming back
// from a stepped flow, which renders outside it, mounts it afresh — since the server's answer is
// only as new as the last full page load.
function savedOpen(): boolean {
  if (!browser) return data.sidebarOpen;
  const saved = document.cookie.match(new RegExp(`(?:^|; )${SIDEBAR_COOKIE_NAME}=([^;]*)`));
  return saved ? saved[1] !== "false" : true;
}
let sidebarOpen = $state(untrack(savedOpen));
// Every change is saved, however it was made: the fold button, the shortcut, the sheet.
$effect(() => {
  document.cookie =
    `${SIDEBAR_COOKIE_NAME}=${sidebarOpen}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
});

// Whether a folding item's sub-links are on screen. The icon rail hides them
// (`group-data-[collapsible=icon]:hidden`) but the mobile sheet always shows them, and the rail
// state alone does not tell the two apart.
const isMobile = new IsMobile();
const subsVisible = $derived(sidebarOpen || isMobile.current);

// On the icon rail, a card beside the hovered icon names it and — for a folding item — lists its
// sub-pages, which the rail itself cannot show. It replaces the per-icon tooltips. Only on the
// desktop rail: open, the sidebar says all of it already, and on mobile it is a sheet.
const flyout = new RailFlyout<NavItem>();
const railOn = $derived(!sidebarOpen && !isMobile.current);
$effect(() => {
  if (!railOn) flyout.hideNow();
});
// A click on the rail navigates with the card still out: it stays through the page transition,
// then closes unless the pointer is still on the rail or the card.
onNavigate((navigation) => {
  flyout.hold();
  void navigation.complete
    .then(viewTransitionFinished)
    .catch(() => {})
    .finally(() => flyout.release());
});

/** The events a rail row hands the card: pointer and keyboard focus alike. */
function railHover(item: NavItem) {
  return {
    onpointerenter: (e: PointerEvent) => {
      if (railOn) flyout.show(item, e.currentTarget as Element);
    },
    onpointerleave: () => flyout.hideSoon(),
    onfocusin: (e: FocusEvent) => {
      if (railOn) flyout.show(item, e.currentTarget as Element);
    },
    onfocusout: () => flyout.hideSoon(),
  };
}

type NavItem = {
  href: string;
  label: string;
  icon: typeof BotIcon;
  // An item with subs is still a page of its own at `href`, and a fold: the chevron beside it
  // shows or hides the subs, whose pages sit under it in the breadcrumb.
  subs?: {
    href: string;
    label: string;
  }[];
  /** Shown only to a user holding it; absent, to everyone signed in. */
  capability?: Capability;
  /** No page of its own at `href`: its crumb names it and links nowhere. */
  unlinked?: boolean;
};

// The day-to-day loop sits flat at the top; everything else lives in a section that folds.
const topItems: NavItem[] = [
  { href: "/agents", label: "Agents", icon: BotIcon },
  { href: "/tasks", label: "Tasks", icon: ListChecksIcon },
  // Pages agents published, which everyone on the instance can open.
  { href: "/artifacts", label: "Artifacts", icon: AppWindowIcon, capability: "artifacts:read" },
  // What starts tasks on its own: webhooks, schedules and chat commands. A response is a task
  // one of them started, so it has no page of its own.
  { href: "/triggers", label: "Triggers", icon: ZapIcon, capability: "automations:manage" },
  {
    href: "/memory",
    label: "Memory",
    icon: BrainIcon,
    capability: "memory:read",
    subs: [
      { href: "/memory/sources", label: "Sources" },
      { href: "/memory/health", label: "Health" },
    ],
  },
];

const sections: { label: string; items: NavItem[] }[] = [
  {
    label: "Code",
    items: [
      { href: "/repos", label: "Repos", icon: FolderGit2Icon },
      { href: "/workspaces", label: "Workspaces", icon: LayersIcon },
      { href: "/patches", label: "Patches", icon: GitPullRequestIcon },
      { href: "/checks", label: "Checks", icon: CircleCheckBigIcon },
      { href: "/builds", label: "Builds", icon: ContainerIcon },
    ],
  },
  {
    label: "Integrations",
    items: [
      { href: "/model-keys", label: "Model keys", icon: KeyRoundIcon, capability: "models:read" },
      { href: "/usage", label: "Usage", icon: ChartColumnIcon, capability: "usage:read-all" },
      { href: "/tool-servers", label: "Tool servers", icon: PlugIcon, capability: "tools:read" },
      { href: "/skills", label: "Skills", icon: BookOpenTextIcon, capability: "skills:read" },
      // The Telegram, Zulip, Slack and Discord connections triggers and responses talk through.
      { href: "/chat", label: "Chat", icon: MessageSquareIcon, capability: "chat:read" },
    ],
  },
];

// Yours alone, so it lives in the avatar menu rather than the nav; listed here so the header's
// breadcrumb still names the page.
const accountItem: NavItem = { href: "/account", label: "Account settings", icon: SettingsIcon };
// The instance's own settings, each shown to whoever holds its capability; their layout sends
// everyone else home.
const instanceItems: (NavItem & { capability: Capability })[] = [
  { href: "/instance/members", label: "Members", icon: UsersIcon, capability: "users:manage" },
  {
    href: "/instance/sign-up",
    label: "Sign-up & email",
    icon: ShieldIcon,
    capability: "settings:manage",
  },
  {
    href: "/instance/platform",
    label: "Platform",
    icon: ServerCogIcon,
    capability: "egress:manage",
  },
];
const visibleTopItems = $derived(
  topItems.filter((item) => item.capability === undefined || can(data.user, item.capability)),
);
const visibleSections = $derived(
  sections.map((section) => ({
    ...section,
    items: section.items.filter((item) =>
      item.capability === undefined || can(data.user, item.capability)
    ),
  })).filter((section) => section.items.length > 0),
);
const visibleInstanceItems = $derived(
  instanceItems.filter((item) => can(data.user, item.capability)),
);

const allItems: NavItem[] = [
  ...topItems,
  ...sections.flatMap((s) => s.items),
  ...instanceItems,
  accountItem,
];

const activePath = $derived(
  allItems.find((item) => page.url.pathname.startsWith(item.href))?.href ?? "/agents",
);

// Sections and folding items start open and remember being folded for the session. Landing on
// a page inside a folded one unfolds it, so the active item is never hidden.
const sectionOpen = $state(Object.fromEntries(sections.map((s) => [s.label, true])));
// Which hrefs are folds, kept as a plain Set so the effect below can ask without touching
// `itemOpen`. It used to ask with `activePath in itemOpen`, and `in` goes through the state
// proxy's `has` trap, which subscribes to the property's VALUE and not merely its existence —
// so the effect depended on the one key it also writes. Folding the item you were currently on
// set it false, woke the effect, and the effect forced it straight back to true: the fold sprang
// open again and its chevron never stayed rotated.
const foldHrefs = new Set(allItems.filter((item) => item.subs).map((item) => item.href));
const itemOpen = $state(Object.fromEntries([...foldHrefs].map((href) => [href, true])));
$effect(() => {
  const owner = sections.find((s) => s.items.some((item) => item.href === activePath));
  if (owner) sectionOpen[owner.label] = true;
  if (foldHrefs.has(activePath)) itemOpen[activePath] = true;
});

const section = $derived(allItems.find((item) => item.href === activePath));
const activeSub = $derived(section?.subs?.find((sub) => page.url.pathname.startsWith(sub.href)));
// A detail page names itself via its load; without one the last link IS the current page.
const crumb = $derived(page.data.breadcrumb as string | undefined);
// A page whose load says `fullWidth` (a wide table) fills the panel instead of the reading column,
// up to a cap past which a row would be too long to read across.
const fullWidth = $derived(page.data.fullWidth === true);
// A view-transition-name is a CSS identifier: the href with everything else made a hyphen.
const crumbName = (href: string) => `crumb-${href.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;

const trail = $derived([
  ...(section ? [section] : []),
  ...(activeSub ? [activeSub] : []),
  ...(crumb ? [{ href: page.url.pathname, label: crumb }] : []),
]);

// A lone crumb only names the page, and the page's title says that already: the bar stays out
// of sight (from md up, where it carries nothing else) until the title scrolls up under it, and
// comes in as the title goes. Not while a page keeps controls there, which must stay in reach:
// such a page says so in its load (`headerControls`), as its own effect hands the bar the
// controls only after hydration, and the server must render the first page the way it will
// look. Not on an error page either, nor on any page with no title to hand over to: the server
// cannot see the title, so it takes one to be there, and the browser checks once it has mounted
// (the page's title registers itself before this layout's mount effect runs).
let mounted = $state(false);
$effect(() => {
  mounted = true;
});
const headerFolds = $derived(
  trail.length <= 1 &&
    page.error === null &&
    page.data.headerControls !== true &&
    pageHeader.controls === null &&
    (!mounted || pageHeader.title !== null),
);
let headerEl = $state<HTMLElement | null>(null);
/** How far the bar has come in: 0 out of sight, 1 all there. Follows the scroll, frame by frame. */
let reveal = $state(0);
// The crumbs are named for a view transition (see the trail below) only while they are all
// there. A folded crumb is faded and lowered, and a crumb named on both sides glides from one
// look to the other: going from a suite back to the list, it sank and faded against the page's
// slide. Unnamed, the crumbs a folded side lacks come and go with the page, as any crumb only
// one side has does.
const crumbsNamed = $derived(!headerFolds || isMobile.current || reveal === 1);
$effect(() => {
  const title = pageHeader.title;
  const bar = headerEl;
  // Each folding page starts folded, and reads its own scroll from there: what a page before it
  // left here says nothing about this one.
  if (!headerFolds || bar === null || title === null) {
    reveal = 0;
    return;
  }
  // From the title's foot reaching the bar's foot to it reaching the bar's top: the bar comes in
  // over exactly the scroll that carries the title up through it.
  const update = () => {
    const b = bar.getBoundingClientRect();
    const t = title.getBoundingClientRect();
    reveal = Math.min(1, Math.max(0, (b.bottom - t.bottom) / b.height));
  };
  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update, { passive: true });
  return () => {
    window.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
  };
});

// The tasks section shows its list in a pane beside the page panel, and a pane beside the panel can
// only be placed here: everything a child layout renders lands inside it. The list itself is still
// the section's own — `tasks/+layout.ts` loads its first page — and this reads it back off
// `page.data`.
const onTasks = $derived(page.url.pathname.startsWith("/tasks"));
// Read ONLY on the section: `page.data` is whatever the current route loaded, and another route
// is free to return a `tasks` of its own shape — the usage page hands back a plain array of the
// tasks its report names, and seeding the list from that read `.at` off a field it does not have.
const loadedTasks = $derived(onTasks ? page.data.tasks as TaskPage | undefined : undefined);
const showPane = $derived(loadedTasks !== undefined);

// ONE list for the section, shared through context. The pane and the index page's table are two
// drawings of the same rows and are mounted at the same time — the pane is only hidden by CSS
// below xl — so a list per view would mean two page loads, two streams, and two answers to the
// question of what is on screen. The load's page seeds it here rather than in an effect so the
// server's render has rows in it; effects are the browser's alone.
const taskList = setTaskListContext(untrack(() => new LiveTaskList(loadedTasks)));

// Every load after that one — a filter change, a task cancelled, an `invalidate` — hands its page
// over the same way. Untracked because `seed` both reads and writes the list's own rows, and an
// effect that depended on what it writes would wake itself forever.
$effect(() => {
  const loaded = loadedTasks;
  if (loaded === undefined) return;
  untrack(() => taskList.seed(loaded));
});

// The live tail, open only while the section is on screen. `connect` reads the filters the list
// was seeded with, which is also what ties this effect to them — nothing narrows a list today,
// but when something does, the stream watching the old one closes here and one watching the new
// one opens.
$effect(() => {
  if (!onTasks) return;
  return taskList.connect();
});

// The details pane remembers being shut, and its width, in cookies the server reads too. Adopted
// once, as the sidebar's fold is: after that the pane's own state is the truth. Never on the
// server, where the pane's state is shared between requests.
if (browser) {
  untrack(() => {
    detailsPane.open = data.detailsPaneOpen;
    if (data.detailsPaneWidth !== null) detailsPane.width = data.detailsPaneWidth;
  });
}
// What the server holds for the pane on a page that has one, until the page hands it over.
const paneReserve = $derived(
  page.data.detailsPane === true && data.detailsPaneOpen
    ? Math.min(
      DETAILS_PANE_MAX,
      Math.max(DETAILS_PANE_MIN, data.detailsPaneWidth ?? DETAILS_PANE_INITIAL),
    )
    : null,
);

// The room the panel and the pane share: from the panel's left edge to the window's. The panel
// resizes whenever anything to its left does — the sidebar folding, the tasks pane coming and
// going — and the window with it, so the panel's own box is what is watched.
let insetEl = $state<HTMLElement | null>(null);
$effect(() => {
  const el = insetEl;
  if (el === null) return;
  const measure = () => {
    detailsPane.room = document.documentElement.clientWidth - el.getBoundingClientRect().left;
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(el);
  window.addEventListener("resize", measure, { passive: true });
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", measure);
  };
});

const initials = $derived(personInitials(data.user.name));

// The logo perks up at every new page, as it does on the landing page.
afterNavigate(({ type, from, to }) => {
  if (type !== "enter" && from?.url.pathname !== to?.url.pathname) excite();
});

async function handleLogOut() {
  await logOut();
  // Re-run all loads so the login page sees the cleared session — otherwise
  // its guard reads the stale `user` and bounces straight back here.
  await goto("/login", { invalidateAll: true });
}
</script>

<!-- Every label in here is a `<span class="truncate">`, and both halves of that matter while the
     rail animates between its two widths. A bare text node reflows as the button narrows — the
     menu button only nowraps `span:last-child`, which a bare node is not and a folding item's
     label is not either, since its chevron follows it. `truncate` also zeroes the span's
     min-content size, which is what lets it shrink inside the flex row instead of holding the
     row open and pushing the icon off. -->
<!-- What the rail's card says about one item: its name as a link, level with the icon it came
     from (the card's first row is exactly a menu row tall), and its sub-pages under it. -->
{#snippet flyoutCard(item: NavItem)}
  {@const onSub = item.subs?.some((sub) => page.url.pathname.startsWith(sub.href)) ?? false}
  <!-- A plain item's card hugs its label; one with sub-pages is a menu, and takes a menu's width. -->
  <div class={["flex flex-col p-1 text-sm", item.subs && "min-w-44"]}>
    <a
      href={item.href}
      class={[
        "hover:bg-accent flex h-8 items-center rounded-md px-2 font-medium whitespace-nowrap",
        activePath === item.href && !onSub && "bg-accent",
      ]}
    >
      {item.label}
    </a>
    {#if item.subs}
      <div class="mt-0.5 flex flex-col border-t pt-1">
        {#each item.subs as sub (sub.href)}
          <a
            href={sub.href}
            class={[
              "hover:bg-accent hover:text-foreground flex h-8 items-center rounded-md px-2",
              page.url.pathname.startsWith(sub.href)
                ? "bg-accent text-foreground"
                : "text-muted-foreground",
            ]}
          >
            {sub.label}
          </a>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet navItem(item: NavItem)}
  {#if item.subs}
    {@const subActive = item.subs.some((sub) => page.url.pathname.startsWith(sub.href))}
    <!-- The parent is a link like any other; folding is the chevron's job alone, a separate
         button in the item's action slot, so a click on the name always navigates and a click on
         the chevron never does. Its own group name, not `collapsible`: this fold can render INSIDE
         a section's `group/collapsible`, and a named group matches any ancestor carrying the name,
         not the nearest one. -->
    <Collapsible.Root bind:open={itemOpen[item.href]} class="group/nav-fold">
  <Sidebar.MenuItem {...railHover(item)}>
    <!-- The highlight is the parent's on its own pages; on a sub's page the sub carries it —
         unless the subs are off screen (the icon rail), and then the parent is all there is. -->
    <Sidebar.MenuButton
      isActive={activePath === item.href && (!subActive || !subsVisible)}
    >
          {#snippet child({ props })}
            <a href={item.href} {...props}>
              <item.icon />
              <span class="truncate">{item.label}</span>
            </a>
          {/snippet}
        </Sidebar.MenuButton>
    <Collapsible.Trigger>
          {#snippet child({ props })}
            <Sidebar.MenuAction
              {...props}
              aria-label={itemOpen[item.href] ? `Hide ${item.label} pages` : `Show ${item.label} pages`}
              class="data-[state=open]:rotate-90"
            >
              <ChevronRightIcon />
            </Sidebar.MenuAction>
          {/snippet}
        </Collapsible.Trigger>
    <Collapsible.Content>
      <Sidebar.MenuSub>
            {#each item.subs as sub (sub.href)}
              <Sidebar.MenuSubItem>
                <Sidebar.MenuSubButton
                  href={sub.href}
                  isActive={page.url.pathname.startsWith(sub.href)}
                >
                  <span>{sub.label}</span>
                </Sidebar.MenuSubButton>
              </Sidebar.MenuSubItem>
            {/each}
          </Sidebar.MenuSub>
    </Collapsible.Content>
  </Sidebar.MenuItem>
</Collapsible.Root>
  {:else}
    <Sidebar.MenuItem {...railHover(item)}>
  <Sidebar.MenuButton isActive={activePath === item.href}>
        {#snippet child({ props })}
          <a href={item.href} {...props}>
            <item.icon />
            <span class="truncate">{item.label}</span>
          </a>
        {/snippet}
      </Sidebar.MenuButton>
</Sidebar.MenuItem>
  {/if}
{/snippet}

<Sidebar.Provider bind:open={sidebarOpen}>
  <!-- The width override is the seam's single source of truth. Stock makes the collapsed container
       `icon + 4 + 2px` while the gap it reserves in flow is `icon + 4` — a 2px overhang that
       everything anchored to this container's right edge inherits: the fold disc below landed 2px
       off the panel border it is meant to sit on. There is no
       border on this container under `variant="inset"` for those 2px to account for, and without
       them the inner surface is exactly one icon wide. -->
  <Sidebar.Root
    collapsible="icon"
    variant="inset"
    class="group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]! [view-transition-name:sidebar]"
  >
    <Sidebar.Header>
      <Sidebar.Menu>
        <Sidebar.MenuItem>
          <!-- The same height and padding folded or not, against stock's `size-8` and `p-0` on the
               rail: the row shrinking as the sidebar folded moved every item below it up and
               down. -->
          <Sidebar.MenuButton
            size="lg"
            class="h-10 overflow-visible group-data-[collapsible=icon]:h-10! group-data-[collapsible=icon]:p-2!"
          >
            {#snippet child({ props })}
              <!-- One logo for both states, folding down to the mark as the sidebar folds rather than
                   swapping drawings at one end of the animation. Open, it sits 8px left of the
                   row's padding. Folded, it shrinks about the circle's middle (26% across, half way
                   down the wordmark's box) and moves 6px left of that padding, onto the icons'
                   column: unmoved, the circle's middle is 22px into the row, the icons' 16px. Sized with `!` over the button's own rule for icons, which would make it a
                   16px square; the button lets it spill over, as the blob bulges past the circle's
                   edge and, folded, the faded letters past the rail. In a div, because the button
                   truncates and fades its last span as a label. Named `ryph-logo` for view transitions, as
                   every layout's logo is, so it holds still across them (see layout.css). -->
              <a href="/agents" aria-label="Ryph" {...props}>
                <div class="flex shrink-0 items-center">
                  <RyphLogo
                    folded={!sidebarOpen && !isMobile.current}
                    class="h-7! w-auto! origin-[26%_50%] -translate-x-2 [view-transition-name:ryph-logo] transition-[translate,scale] duration-250 ease-in-out motion-reduce:transition-none group-data-[collapsible=icon]:-translate-x-1.5 group-data-[collapsible=icon]:scale-[0.82]"
                  />
                </div>
              </a>
            {/snippet}
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.Header>

    <Sidebar.Content>
      <Sidebar.Group>
        <Sidebar.GroupContent>
          <Sidebar.Menu>
            {#each visibleTopItems as item (item.href)}
              {@render navItem(item)}
            {/each}
          </Sidebar.Menu>
        </Sidebar.GroupContent>
      </Sidebar.Group>
      {#each visibleSections as section (section.label)}
        <!-- The icon rail hides section labels, so a folded section would take its items with it:
             every section stands open while the rail is narrow, and folds back once it widens. -->
        <Collapsible.Root
          bind:open={
            () => sectionOpen[section.label] || !sidebarOpen,
            (open) => (sectionOpen[section.label] = open)
          }
          class="group/collapsible"
        >
          <Sidebar.Group>
            <Sidebar.GroupLabel>
              {#snippet child({ props })}
                <Collapsible.Trigger {...props}>
                  {section.label}
                  <ChevronRightIcon
                    class="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90"
                  />
                </Collapsible.Trigger>
              {/snippet}
            </Sidebar.GroupLabel>
            <Collapsible.Content>
              <Sidebar.GroupContent>
                <Sidebar.Menu>
                  {#each section.items as item (item.href)}
                    {@render navItem(item)}
                  {/each}
                </Sidebar.Menu>
              </Sidebar.GroupContent>
            </Collapsible.Content>
          </Sidebar.Group>
        </Collapsible.Root>
      {/each}
      {#if visibleInstanceItems.length > 0}
        <Sidebar.Group>
          <Sidebar.GroupLabel>Instance</Sidebar.GroupLabel>
          <Sidebar.GroupContent>
            <Sidebar.Menu>
              {#each visibleInstanceItems as item (item.href)}
                {@render navItem(item)}
              {/each}
            </Sidebar.Menu>
          </Sidebar.GroupContent>
        </Sidebar.Group>
      {/if}
    </Sidebar.Content>

    <Sidebar.Footer>
      <Sidebar.Menu>
        <Sidebar.MenuItem>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Sidebar.MenuButton
                  {...props}
                  size="lg"
                  class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Avatar.Root>
                    <Avatar.Fallback>{initials}</Avatar.Fallback>
                  </Avatar.Root>
                  <div class="grid flex-1 text-left text-sm leading-tight">
                    <span class="truncate font-medium">{data.user.name}</span>
                    <span class="text-muted-foreground truncate text-xs">{data.user.email}</span>
                  </div>
                  <ChevronsUpDownIcon class="ml-auto" />
                </Sidebar.MenuButton>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content
              side="top"
              align="start"
              class="w-(--bits-dropdown-menu-anchor-width) min-w-56"
            >
              <DropdownMenu.Label>
                <div class="flex flex-col gap-0.5">
                  <span>{data.user.name}</span>
                  <span class="text-muted-foreground text-xs font-normal">{data.user.email}</span>
                </div>
              </DropdownMenu.Label>
              <DropdownMenu.Separator />
              <DropdownMenu.Group>
                <DropdownMenu.Item>
                  {#snippet child({ props })}
                    <a {...props} href={accountItem.href}>
                      <SettingsIcon />
                      Account settings
                    </a>
                  {/snippet}
                </DropdownMenu.Item>
                <DropdownMenu.Item onclick={handleLogOut}>
                  <LogOutIcon />
                  Log out
                </DropdownMenu.Item>
              </DropdownMenu.Group>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.Footer>

    <!-- The fold control, now that the header has none. It rides the sidebar container, which is
         `fixed inset-y-0` and animates its own width: `right-0` is therefore the seam between the
         nav and whatever the page puts next to it, `top-1/2` is the middle of the viewport rather
         than of the document, and the disc tracks the fold instead of jumping across at the end of
         it. The ONLY fold control on desktop: stock's `Sidebar.Rail` — an invisible strip along the
         seam that drew a hairline on hover and folded on click — is deliberately not used, since a
         line appearing wherever the pointer grazed the edge read as a glitch, not a control.
         `md:flex` because below md the sidebar is an off-canvas sheet: no seam to sit on, and the
         header keeps a trigger there instead.
         Named for view transitions because half of it hangs past the seam: inside the sidebar's
         snapshot it was cut down the middle by that group's clip (see layout.css). -->
    <button
      type="button"
      onclick={() => (sidebarOpen = !sidebarOpen)}
      aria-label="Toggle sidebar"
      title="Toggle sidebar"
      class="bg-background text-muted-foreground hover:text-foreground hover:bg-muted absolute top-1/2 right-0 z-20 hidden size-6 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border shadow-sm transition-colors md:flex [view-transition-name:sidebar-fold]"
    >
      {#if sidebarOpen}
        <ChevronLeftIcon class="size-3.5" />
      {:else}
        <ChevronRightIcon class="size-3.5" />
      {/if}
    </button>
  </Sidebar.Root>

  {#if railOn}
    <RailFlyoutCard {flyout}>
      {#snippet children(item: NavItem)}
        {@render flyoutCard(item)}
      {/snippet}
    </RailFlyoutCard>
  {/if}

  {#if showPane}
    <TaskListPane list={taskList} />
  {/if}

  <!-- The page panel, floating on the sidebar's background: `variant="inset"` above gives the
       wrapper `bg-sidebar` and this element a margin, a radius and a shadow. The border is ours —
       a shadow alone leaves the panel's edge undefined against a surround this close in lightness.
       Both are md-only, matching the margin: on mobile the panel is flush and neither applies.

       The `ml-0!` puts the panel's edge back on the seam — the width the sidebar reserves in flow —
       in BOTH fold states. Stock adds `ml-2` while collapsed, which pushed this edge 8px past the
       seam everything else lines up on: the fold button rides it, and the tasks pane's border sits
       on it with no margin of its own, so the three only agree here. It also un-skews the icon
       rail, which was 16px of surround to the left of its icons and 24px to the right.

       `min-w-0` because a flex item's automatic minimum size is its MIN-CONTENT width, so one
       unbreakable string anywhere on a page — a long error line, a path, a token — widened this
       panel past its share, the flex row past the viewport, and the whole document with it. The
       page then scrolled sideways and took the pane along, since `sticky` only pins vertically.
       With the floor at 0 the panel keeps its share and the overflow stays where it belongs: a
       `truncate` clips, a table scrolls in its own container. -->
  <Sidebar.Inset
    bind:ref={insetEl}
    class={[
      // Outlined, not lifted: the border alone sets the panel off the canvas.
      "min-w-0 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0! md:border md:peer-data-[variant=inset]:shadow-none",
      // A docked details pane sits right against the panel, as the tasks pane does on its left.
      detailsPane.shown && detailsPane.docked && "md:mr-0!",
    ]}
  >
    <!-- The panel's top edge, pinned. The panel floats 8px down the canvas and wears a 1px border,
         so its content starts 9px below the top of the viewport — and a header stuck at `top-0`
         slid those 9px before it caught, every time, while the canvas band above it scrolled away
         and the transcript ran through the gap. This cap is that band and that edge, drawn once
         more as a sticky element whose rest position IS its stuck position (`-mt` pulls it up to
         the viewport's edge, `top-0` holds it there), so it never moves. At rest it paints
         pixel-for-pixel over what is already there: canvas, then the panel's own rounded top with
         its border and shadow (the inner box is that corner, radius and all; its spread shadow
         fills the two cutouts with canvas, and the wrapper clips the rest). The border is a pair of
         inset rings, `--border` over `--background`, because the dark `--border` is translucent:
         as a plain border over the panel's own it doubled at rest, a lighter edge down the first
         16px of each side. Opaque underneath, it comes out the same over the panel's border as
         over a scrolled page. The panel's `shadow-sm` is drawn again under the corner, since the
         canvas this paints at the sides covers the real one. Scrolled, it paints the same picture
         over the transcript, and the panel looks pinned where it was. Everything a page sticks
         parks at `top-(--panel-cap)` below it — see layout.css. Above the headers (z-20) because
         the corners overlap their top 16px. Below md the panel is flush: nothing to pin.
         3px wider than the panel on each side (`-mx-1` against the 1px border), because the
         panel casts `shadow-sm` down its sides, and once scrolled those sides run up through this
         band: at exactly the panel's width the shadow showed beside it as a short dark tick at
         the top of the seam. The extra width is canvas over canvas at rest.
         Named for view transitions during a navigation within a section (the attribute the root
         layout sets), so it holds still while a page slides in below it — and so the slide has
         nothing to expose: the root image moving 12px opens a strip above the header, and that
         strip is exactly this band. Between sections it is unnamed and moves with the page. -->
    <div
      aria-hidden="true"
      class="bg-sidebar sticky top-0 z-20 -mx-1 -mt-(--panel-cap) hidden h-(--panel-cap) shrink-0 md:block [[data-navigation=within-section]_&]:[view-transition-name:panel-cap]"
    >
      <div class="absolute inset-x-0 top-0 h-6 overflow-clip">
        <div class="mt-2 mx-[3px] h-8 rounded-t-xl shadow-[inset_0_0_0_1px_var(--border),inset_0_0_0_1px_var(--background),0_0_0_1rem_var(--sidebar)]"></div>
      </div>
    </div>

    <!-- Sticks to the viewport: nothing between here and the document is a scroll container (the
         sidebar wrapper is min-h-svh, not a fixed-height overflow box), so the page itself scrolls.
         The background is load-bearing — the header is transparent otherwise and the timeline would
         scroll through it. It parks under the cap above, which owns the panel's corners.
         Named for view transitions during a navigation within a section: the bar holds still
         while the page slides in under it, and each crumb is named on its own below, so only the
         crumb the navigation changes moves with the page. Between sections nothing here is named
         and the bar moves with the rest — a different section is a different page. Holding the
         bar still used to open a strip of canvas above it as the panel slid; the cap, named on the
         same terms, sits over exactly that strip. See layout.css. -->
    <!-- Gone wherever the pane is: the pane names the open task and is the way back to its
         siblings, so the crumb above the panel only says it again. It stays below xl, where there
         is no pane — there the crumb IS the way back up, and on a phone this bar also carries the
         only trigger for the nav sheet. -->
    <!-- Folding (`headerFolds`, from md up): out of the flow (`-mb-14`), so the page's title starts
         at the top, and see-through, its fill and rule a layer of their own that fades in with
         `--reveal` while the crumb rises into place with it. Out of sight it takes no clicks. -->
    <header
      bind:this={headerEl}
      data-folds={headerFolds || undefined}
      data-out={(headerFolds && reveal === 0) || undefined}
      style:--reveal={headerFolds ? reveal : 1}
      class={[
        "bg-background sticky top-0 z-10 flex h-14 items-center gap-3 border-b px-4 md:top-(--panel-cap) md:px-6 [[data-navigation=within-section]_&]:[view-transition-name:app-header]",
        "md:data-folds:-mb-14 md:data-folds:border-transparent md:data-folds:bg-transparent md:data-out:pointer-events-none",
        showPane && "xl:hidden",
      ]}
    >
      {#if headerFolds}
        <div
          aria-hidden="true"
          class="bg-background absolute inset-x-0 top-0 -bottom-px -z-10 hidden border-b opacity-(--reveal) md:block"
        ></div>
      {/if}
      <!-- Mobile only: down there the sidebar is an off-canvas sheet, the seam the fold button
           hangs on does not exist, and this is the only way back to the nav. -->
      <Sidebar.Trigger class="md:hidden" />
      <Separator orientation="vertical" class="h-4 md:hidden" />
      <!-- Scrolls sideways when the trail is longer than the bar, fading out at whichever end has
           more, rather than squeezing every crumb into the next. It rests at its start, so the
           section the page is in always shows; the page's own name is the part that runs on. -->
      <Breadcrumb.Root
        class={[
          "scroll-fade-x min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]",
          headerFolds &&
            "md:translate-y-[calc((1-var(--reveal))*0.75rem)] md:opacity-(--reveal) motion-reduce:md:translate-y-0",
        ]}
      >
        <Breadcrumb.List class="flex-nowrap whitespace-nowrap *:shrink-0">
          <!-- Within a section, each crumb and the chevron before it are named by where the crumb
               leads, so the crumbs both pages share keep their groups and hold still, and any
               crumb only one side has — the one a deeper page adds, a shallower one drops, or a
               sibling's in place of this one's — is alone in its group and takes the page's own
               fade and slide (the `crumb` class, in layout.css). The name rides a custom property
               so the same attribute-gated class can apply it. -->
          {#each trail as node, i (node.href)}
            {@const name = crumbName(node.href)}
            {#if i > 0}
              <Breadcrumb.Separator
                class={[
                  "[view-transition-class:crumb]",
                  crumbsNamed && "[[data-navigation=within-section]_&]:[view-transition-name:var(--crumb)]",
                ]}
                style="--crumb: {name}-separator"
              />
            {/if}
            <Breadcrumb.Item
              class={[
                "[view-transition-class:crumb]",
                crumbsNamed && "[[data-navigation=within-section]_&]:[view-transition-name:var(--crumb)]",
              ]}
              style="--crumb: {name}"
            >
              {#if i < trail.length - 1 && "unlinked" in node && node.unlinked}
                <span>{node.label}</span>
              {:else if i < trail.length - 1}
                <Breadcrumb.Link href={node.href}>{node.label}</Breadcrumb.Link>
              {:else}
                <Breadcrumb.Page class="font-medium">{node.label}</Breadcrumb.Page>
              {/if}
            </Breadcrumb.Item>
          {/each}
        </Breadcrumb.List>
      </Breadcrumb.Root>
      <!-- A page's own controls, at the bar's far end: what it asked to keep in reach while it
           scrolls (see page-header.svelte.ts). -->
      {#if pageHeader.controls}
        <div class="ml-auto flex min-w-0 shrink-0 items-center gap-3">
          {@render pageHeader.controls()}
        </div>
      {/if}
    </header>
    <!-- `@container` so a page can size something against the panel rather than against the
         column below: the task masthead bleeds out to the panel's edges with `100cqw`. Inline-size
         containment costs nothing here — the width comes from the flex row above, and nothing in
         a page is `fixed`, which layout containment would have re-parented.
         Not named for view transitions, deliberately: a named element is captured from its own
         top, so with the old page scrolled and the new one opening at the top, its group flew the
         whole scroll distance. The page's content moves as part of the root instead, which is
         viewport-anchored; what holds still is the chrome around it, each piece named. -->
    <!-- The gutters are variables so a page that bleeds to the panel's edges can take back exactly
         what is here: tighter on a phone, where 24px a side is a tenth of the screen. Tasks keep
         that 16px side gutter on desktop too, matching the docked composer's bottom inset. -->
    <!-- `isolate`: a stacking context of its own, so whatever a page lifts with a z-index stays
         inside it and the bar above always paints over the page. Cards lift their actions to
         `relative z-10` over a stretched link, the header's own z-index, and being later in the
         document those badges and buttons scrolled OVER the bar; the page table's z-20 sticky
         head did the same. Every z-index in a page now only orders things within the page. -->
    <div
      class={[
        "@container isolate flex-1 px-(--page-gutter) py-(--page-gutter-y) [--page-gutter-y:--spacing(6)] [--page-gutter:--spacing(4)] md:[--page-gutter-y:--spacing(8)]",
        activePath !== "/tasks" && "md:[--page-gutter:--spacing(6)]",
      ]}
    >
      <div class={["mx-auto", fullWidth ? "max-w-[100rem]" : "max-w-5xl"]}>
        {@render children()}
      </div>
    </div>

    <!-- The panel's bottom edge, the cap's mirror: the border row and the 8px of canvas under it,
         with the rounded corners, border and shadow drawn the same way. In flow rather than pinned — the panel ends
         where it ends — so at rest it paints exactly what is already there. Its one job is the
         view transition: named within a section like the cap, it holds the panel's end still while
         the page slides, which the root snapshot otherwise carried 12px up and back on every short
         page — the one piece of the panel's frame a vertical slide makes visible.
         Like the top cap, it must paint above z-10 sticky content: the task composer bleeds to
         the panel's edges and would otherwise cover the bottom corner cutouts. -->
    <div
      aria-hidden="true"
      class="bg-sidebar relative z-20 -mx-1 -mb-(--panel-cap) hidden h-(--panel-cap) shrink-0 md:block [[data-navigation=within-section]_&]:[view-transition-name:panel-foot]"
    >
      <div class="absolute inset-x-0 bottom-0 h-6 overflow-clip">
        <div class="-mt-4 mx-[3px] h-8 rounded-b-xl shadow-[inset_0_0_0_1px_var(--border),inset_0_0_0_1px_var(--background),0_0_0_1rem_var(--sidebar)]"></div>
      </div>
    </div>
  </Sidebar.Inset>

  <DetailsPaneHost reserve={paneReserve} />
</Sidebar.Provider>
