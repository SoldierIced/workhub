import { Briefcase, Building2, BookOpen, Code, FlaskConical, Globe, Heart, House, Layers, Rocket, Shield, Star, Wrench, Zap, type LucideIcon } from 'lucide-react'

/** The icons a profile can wear, by the id stored in `Profile.symbol`. */
export const PROFILE_SYMBOLS: Readonly<Record<string, LucideIcon>> = {
  briefcase: Briefcase,
  house: House,
  code: Code,
  rocket: Rocket,
  building: Building2,
  star: Star,
  flask: FlaskConical,
  heart: Heart,
  globe: Globe,
  shield: Shield,
  layers: Layers,
  zap: Zap,
  book: BookOpen,
  wrench: Wrench
}

export const PROFILE_SYMBOL_IDS = Object.keys(PROFILE_SYMBOLS)

/** The icon for a stored symbol id; undefined when none is set or it is not one we know. */
export function profileSymbol(id: string | undefined): LucideIcon | undefined {
  return id ? PROFILE_SYMBOLS[id] : undefined
}
