import { atom } from 'jotai'
import { createEmptyTeamDraft, teamDraftEquals } from '../../features/teams/teamGraph'

export const teamDraftAtom = atom(createEmptyTeamDraft())
export const teamBaselineAtom = atom(createEmptyTeamDraft())
export const teamSelectionAtom = atom({ id: null, type: 'team' })
export const teamDirtyAtom = atom((get) => !teamDraftEquals(get(teamDraftAtom), get(teamBaselineAtom)))
