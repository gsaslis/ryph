<script lang="ts">
import { beforeNavigate, goto } from "$app/navigation";
import * as AlertDialog from "$lib/components/ui/alert-dialog";

// Stops a page with unsaved changes from being left by accident. Mounted by any page that can
// say whether it is dirty: an in-app navigation — a link, the back button — is held while this
// asks; leaving the app altogether (closing the tab, reloading, typing another address) gets the
// browser's own prompt, which is the only prompt the browser allows there. Once the page has
// saved it passes `dirty={false}` and the next navigation goes through untouched.
let {
  dirty,
  title = "Leave without saving?",
  description = "Your changes have not been saved and will be lost.",
}: {
  dirty: boolean;
  title?: string;
  description?: string;
} = $props();

// Where the held navigation was going, while the question is open.
let pending = $state<URL | null>(null);
// Set once the person chose to leave, so the navigation this then starts is let through.
let leaving = false;

beforeNavigate((navigation) => {
  if (!dirty || leaving) return;
  // A `leave` is the browser going elsewhere: cancelling it is how SvelteKit shows the native
  // "changes you made may not be saved" prompt — the one prompt allowed on unload.
  if (navigation.type === "leave") {
    navigation.cancel();
    return;
  }
  if (navigation.to === null) return;
  navigation.cancel();
  pending = navigation.to.url;
});

function leave() {
  const to = pending;
  pending = null;
  if (to === null) return;
  leaving = true;
  void goto(to).finally(() => {
    leaving = false;
  });
}
</script>

<AlertDialog.Root
  open={pending !== null}
  onOpenChange={(open) => {
    if (!open) pending = null;
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{title}</AlertDialog.Title>
      <AlertDialog.Description>{description}</AlertDialog.Description>
    </AlertDialog.Header>
    <!-- Staying is the safe answer, so it is the filled one and the one Enter picks; leaving is
         the outline beside it. -->
    <AlertDialog.Footer>
      <AlertDialog.Action variant="outline" onclick={leave}>Leave</AlertDialog.Action>
      <AlertDialog.Cancel variant="default">Stay</AlertDialog.Cancel>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
