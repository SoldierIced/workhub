import { useEffect, useState } from 'react'
import { Square, Volume2 } from 'lucide-react'
import { appOptions, DEFAULT_SPEECH_RATE, SPEECH_RATE_RANGE, type Result, type WorkhubConfig } from '@workhub/core'
import { Button, Select, Switch } from '../components/atoms'
import { SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { usePlatform } from '../lib/platform'
import { speak, stopSpeaking, stopSpeakingKeys, useSpeakingId, useVoices } from '../lib/readAloud'
import { SettingRow, SettingsGroup } from './settings/SettingsLayout'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

const TEST_ID = 'voice-test'

/** "Isabela (es-AR)": the voices in language order, so the list reads by language. */
export function voiceOptions(voices: readonly { name: string; lang: string }[]): { value: string; label: string }[] {
  return [...voices]
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
    .map((v) => ({ value: v.name, label: `${v.name} (${v.lang.replace('_', '-')})` }))
}

/** Settings → read replies aloud: voice, speed, test and the default for new sessions. */
export function VoiceSettingsGroup({ config, editable, run }: { config: WorkhubConfig; editable: boolean; run: Run }) {
  const { t } = useI18n()
  const platform = usePlatform()
  const options = appOptions(config)
  const voices = useVoices()
  const speakingId = useSpeakingId()
  const [rate, setRate] = useState(options.speechRate)
  useEffect(() => setRate(options.speechRate), [options.speechRate])
  const known = voices.some((v) => v.name === options.speechVoice)
  const save = (patch: Parameters<typeof window.hub.config.saveOptions>[0]) => void run(() => window.hub.config.saveOptions(patch))
  const voiceList = voiceOptions(voices)
  const missing = options.speechVoice !== '' && voices.length > 0 && !known
  return (
    <SettingsGroup title={t('voice.group')} help={t('voice.help')} footnote={t('voice.shortcutNote', { keys: stopSpeakingKeys(platform) })}>
      <SwitchRow label={t('voice.default')} hint={t('voice.defaultHint')}>
        <Switch checked={options.readAloud} disabled={!editable} onChange={(on) => save({ readAloud: on })} />
      </SwitchRow>
      <SettingRow label={t('voice.voice')} hint={voices.length === 0 ? t('voice.unsupported') : missing ? t('voice.missing') : undefined}>
        <Select
          aria-label={t('voice.voice')}
          value={options.speechVoice}
          disabled={!editable}
          onChange={(v) => save({ speechVoice: v })}
          options={[
            { value: '', label: t('voice.system') },
            ...(missing ? [{ value: options.speechVoice, label: t('voice.notInstalled', { voice: options.speechVoice }) }] : []),
            ...voiceList
          ]}
        />
      </SettingRow>
      <SettingRow label={t('voice.rate')} hint={t('voice.wpm', { wpm: rate })}>
        <input
          type="range"
          aria-label={t('voice.rate')}
          min={SPEECH_RATE_RANGE[0]}
          max={SPEECH_RATE_RANGE[1]}
          step={5}
          value={rate}
          disabled={!editable}
          className="w-full accent-[var(--wh-accent)]"
          onChange={(e) => setRate(Number(e.target.value) || DEFAULT_SPEECH_RATE)}
          // One write when the thumb is let go, not one per step of the drag.
          onPointerUp={() => rate !== options.speechRate && save({ speechRate: rate })}
          onKeyUp={() => rate !== options.speechRate && save({ speechRate: rate })}
        />
      </SettingRow>
      <div className="flex justify-end py-3">
        {speakingId === TEST_ID ? (
          <Button size="sm" icon={<Square className="size-3.5" aria-hidden />} onClick={stopSpeaking}>
            {t('voice.stop')}
          </Button>
        ) : (
          <Button size="sm" icon={<Volume2 className="size-3.5" aria-hidden />} onClick={() => speak(t('voice.sample'), { id: TEST_ID, voice: options.speechVoice, wpm: rate })}>
            {t('voice.test')}
          </Button>
        )}
      </div>
    </SettingsGroup>
  )
}
