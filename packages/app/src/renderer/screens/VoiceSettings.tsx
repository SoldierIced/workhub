import { useEffect, useState } from 'react'
import { Square, Volume2 } from 'lucide-react'
import { appOptions, CLAUDE_MODEL_SUGGESTIONS, DEFAULT_LISTEN_MODEL, DEFAULT_SPEECH_RATE, SPEECH_RATE_RANGE, type WorkhubConfig } from '@workhub/core'
import { Button, Select, Switch } from '../components/atoms'
import { OptionOrCustom, SwitchRow } from '../components/molecules'
import { idOptions } from '../lib/optionOrCustom'
import { useI18n } from '../i18n/I18nProvider'
import { usePlatform } from '../lib/platform'
import { speak, stopSpeaking, stopSpeakingKeys, useSpeakingId, useVoices } from '../lib/readAloud'
import { SettingRow, SettingsGroup } from './settings/SettingsLayout'
import type { Run } from './settings/run'

const TEST_ID = 'voice-test'

/** "Isabela (es-AR)": the voices in language order, so the list reads by language. */
export function voiceOptions(voices: readonly { name: string; lang: string }[]): { value: string; label: string }[] {
  return [...voices]
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
    .map((v) => ({ value: v.name, label: `${v.name} (${v.lang.replace('_', '-')})` }))
}

/** Settings → General › Voice: the default for new sessions, voice and speed (with a test) on one row, and the summary model. */
export function VoiceSettingsGroup({ config, editable, run }: { config: WorkhubConfig; editable: boolean; run: Run }) {
  const { t } = useI18n()
  const platform = usePlatform()
  const options = appOptions(config)
  const voices = useVoices()
  const speakingId = useSpeakingId()
  const [rate, setRate] = useState(options.speechRate)
  useEffect(() => setRate(options.speechRate), [options.speechRate])
  const [model, setModel] = useState(options.listenModel)
  useEffect(() => setModel(options.listenModel), [options.listenModel])
  const saveModel = (value = model) => {
    const next = value.trim()
    if (next !== options.listenModel) save({ listenModel: next })
  }
  const known = voices.some((v) => v.name === options.speechVoice)
  const save = (patch: Parameters<typeof window.hub.config.saveOptions>[0]) => void run(() => window.hub.config.saveOptions(patch))
  const voiceList = voiceOptions(voices)
  const missing = options.speechVoice !== '' && voices.length > 0 && !known
  return (
    <SettingsGroup anchor="voice" title={t('voice.group')} help={t('voice.help')} footnote={t('voice.shortcutNote', { keys: stopSpeakingKeys(platform) })}>
      <SwitchRow label={t('settingsV2.voice.default')} hint={t('voice.defaultHint')}>
        <Switch checked={options.readAloud} disabled={!editable} aria-label={t('settingsV2.voice.default')} onChange={(on) => save({ readAloud: on })} />
      </SwitchRow>
      {/* Voice and speed on one row, with the button that tries them. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3" data-settings-row>
        <div className="min-w-0">
          <span className="block text-base">{t('settingsV2.voice.voiceRate')}</span>
          <p className="text-xs text-subtle">{voices.length === 0 ? t('voice.unsupported') : missing ? t('voice.missing') : t('voice.wpm', { wpm: rate })}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select
            className="w-56"
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
          <input
            type="range"
            aria-label={t('voice.rate')}
            aria-valuetext={t('voice.wpm', { wpm: rate })}
            min={SPEECH_RATE_RANGE[0]}
            max={SPEECH_RATE_RANGE[1]}
            step={5}
            value={rate}
            disabled={!editable}
            className="w-28 accent-[var(--wh-accent)]"
            onChange={(e) => setRate(Number(e.target.value) || DEFAULT_SPEECH_RATE)}
            // One write when the thumb is let go, not one per step of the drag.
            onPointerUp={() => rate !== options.speechRate && save({ speechRate: rate })}
            onKeyUp={() => rate !== options.speechRate && save({ speechRate: rate })}
          />
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
      </div>
      <SettingRow label={t('settingsV2.voice.listenModel')} hint={t('voice.listenModelHint')}>
        <OptionOrCustom
          aria-label={t('settingsV2.voice.listenModel')}
          value={model}
          placeholder={DEFAULT_LISTEN_MODEL}
          disabled={!editable}
          options={idOptions(CLAUDE_MODEL_SUGGESTIONS)}
          onChange={(next) => {
            setModel(next)
            // A choice from the list is saved at once; a typed one when the input loses focus.
            if ((CLAUDE_MODEL_SUGGESTIONS as readonly string[]).includes(next)) saveModel(next)
          }}
          onCustomBlur={() => saveModel()}
          data-testid="voice-listen-model"
        />
      </SettingRow>
    </SettingsGroup>
  )
}
