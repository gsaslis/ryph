import Content from "./tabs-content.svelte";
import Trigger from "./tabs-trigger.svelte";
import Root from "./tabs.svelte";
import List, { type TabsListVariant, tabsListVariants } from "./tabs-list.svelte";

export {
  Content,
  Content as TabsContent,
  List,
  List as TabsList,
  Root,
  //
  Root as Tabs,
  type TabsListVariant,
  tabsListVariants,
  Trigger,
  Trigger as TabsTrigger,
};
