import { Redirect, Stack, useRouter } from "expo-router";
import { useCallback } from "react";
import { ScrollView } from "react-native";

import { CloudWaitlistEnrollment } from "../../features/cloud/CloudWaitlistEnrollment";
import { hasCloudPublicConfig } from "../../features/cloud/publicConfig";
import { useNativeClerkAuthModal } from "../../features/cloud/useNativeClerkAuthModal";

export default function SettingsWaitlistRouteScreen() {
  return hasCloudPublicConfig() ? (
    <ConfiguredSettingsWaitlistRouteScreen />
  ) : (
    <Redirect href="/settings" />
  );
}

function ConfiguredSettingsWaitlistRouteScreen() {
  const { presentAuth } = useNativeClerkAuthModal();
  const router = useRouter();

  const handleSignIn = useCallback(async () => {
    const signedIn = await presentAuth();
    if (signedIn) {
      router.replace("/settings");
    }
  }, [presentAuth, router]);

  return (
    <>
      <Stack.Screen options={{ title: "Join the waitlist" }} />
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          paddingBottom: 32,
          paddingHorizontal: 20,
          paddingTop: 12,
        }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <CloudWaitlistEnrollment onSignIn={() => void handleSignIn()} />
      </ScrollView>
    </>
  );
}
