/** Isolated simulator harness. Never register this as the production entrypoint.
 * Copy it to an isolated checkout's scripts directory and point that checkout's
 * package.json main at this file. See the native gate evidence document.
 */
import React, { useEffect, useState } from 'react';
import { AppState, Button, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import EventMap from '../components/EventMap';
const base = Array.from({ length: 240 }, (_, i) => ({
  id: `native-test-${i}`,
  title: `Native fixture ${i}`,
  date: '2026-09-07T19:00:00Z',
  type: 'game' as const,
  latitude: 40.6 + (i % 20) * 0.015,
  longitude: -74.1 + Math.floor(i / 20) * 0.015,
}));
const clustered = base.map((e, i) => ({
  ...e,
  latitude: 40.75 + (i % 4) * 0.01,
  longitude: -73.95 + (i % 4) * 0.01,
}));
function Harness() {
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const [backgrounds, setBackgrounds] = useState(0);
  useEffect(() => {
    const s = AppState.addEventListener('change', state => {
      console.log('[native-map-harness] appstate', state);
      if (state === 'background') setBackgrounds(n => n + 1);
    });
    return () => s.remove();
  }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setStep(n => Math.min(n + 1, 600)), 50);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (step === 600) setRunning(false);
    if (step % 20 === 0) console.log('[native-map-harness] committed', step);
  }, [step]);
  const phase = step % 6;
  const events =
    phase === 0
      ? []
      : phase === 1
        ? base
        : phase === 2
          ? base.filter((_, i) => i % 2 === 0)
          : clustered;
  return (
    <View style={{ flex: 1, paddingTop: 60 }}>
      <Text testID="native-progress">{`Step ${step}; backgrounds ${backgrounds}; ${step >= 600 ? 'COMPLETE' : 'READY'}`}</Text>
      <Button
        title="Start stress"
        onPress={() => {
          setStep(0);
          setRunning(true);
        }}
      />
      {phase === 4 ? (
        <View style={{ flex: 1 }}>
          <Text>Map unmounted (navigation stand-in)</Text>
        </View>
      ) : (
        <EventMap
          events={events}
          dataLoaded={phase !== 0}
          showUserLocation={false}
          autoFitPins={false}
          initialRegion={{
            latitude: 40.75,
            longitude: -73.95,
            latitudeDelta: 0.5,
            longitudeDelta: 0.5,
          }}
        />
      )}
    </View>
  );
}
registerRootComponent(Harness);
