<script lang="ts">
import * as Alert from "$lib/components/ui/alert";
import UserIcon from "@lucide/svelte/icons/user";
</script>

<!-- Why the controls that add, invite or re-role people are greyed out on a single-user instance. -->
<Alert.Root>
  <UserIcon />
  <Alert.Title>Only you use this instance</Alert.Title>
  <Alert.Description>
    To add people, first set your email and a password on your
    <a href="/account" class="underline underline-offset-4">account page</a>, then start Ryph with
    <code>RYPH_MULTIUSER=on</code>. Sign-in links only work while you are the only user.
  </Alert.Description>
</Alert.Root>
