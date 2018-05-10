const TmLoader = require('./Loader')
const { TmSetting } = require('./Object')
const { TrackParser } = require('./Track')
const TmError = require('./Error')
const EPSILON = 0.0000000001

const defaultPitchDict = [
  { Name: '1', Pitches: 0 },
  { Name: '2', Pitches: 2 },
  { Name: '3', Pitches: 4 },
  { Name: '4', Pitches: 5 },
  { Name: '5', Pitches: 7 },
  { Name: '6', Pitches: 9 },
  { Name: '7', Pitches: 11 }
]

class Parser {
  /**
   * Tm Parser
   * @param {data} tokenizedData 经过tok的JSON对象
   * @example
   * new Parser(tokenizedData)
   */
  constructor(data) {
    this.Sections = data.Sections
    this.libraries = new TmLoader(data.Syntax)
    this.result = {
      Sections: undefined
    }
    this.sectionContext = {
      Settings: new TmSetting(),
      PrevFin: undefined
    }
    this.order = []
  }

  parse() {
    const result = []
    this.expandSection()
    this.libraries.Plugin.proGlobal(this)
    this.Sections.forEach(token => {
      if (token.Type === 'Section') {
        result.push(this.parseSection(token))
      } else {
        this.libraries.Package.applyFunction({
          Settings: this.sectionContext.Settings
        }, token)
      }
    })
    return result.filter(sect => sect.Tracks.length > 0)
  }

  expandSection() {
    const result = []
    for (const section of this.Sections) {
      result.push(...section.Prolog, section, ...section.Epilog)
      delete section.Prolog
      delete section.Epilog
      section.Type = 'Section'
    }
    this.Sections = result
  }

  /**
   * parse section
   * @param {Tm.Section} section
   */
  parseSection(section) {
    const settings = this.sectionContext.Settings.extend()
    for (const setting of section.Settings) {
      setting.Spec.filter((token) => token.Type === 'Function')
        .forEach((token) => this.libraries.Package.applyFunction({ Settings: settings, Context: {} }, token))
    }
    const instrStatistic = {}
    const sec = {
      Tracks: [].concat(...section.Tracks.map((track) => {
        if (track.Name !== undefined) {
          this.libraries.Track[track.Name] = track.Content
        }
        if (track.Play) {
          const tempTracks = []
          if (track.Instruments.length === 0) {
            track.Instruments.push({
              Name: 'Piano',
              Spec: [],
              Dict: defaultPitchDict
            })
          }
          for (const instr of track.Instruments) {
            tempTracks.push(new TrackParser(track, instr, settings, this.libraries).parseTrack())
          }
          for (const tempTrack of tempTracks) {
            if (tempTrack.Instrument in instrStatistic) {
              instrStatistic[tempTrack.Instrument] += 1
            } else {
              instrStatistic[tempTrack.Instrument] = 1
            }
            if (track.ID === '') {
              tempTrack.ID += '#' + instrStatistic[tempTrack.Instrument].toString()
            }
          }
          return tempTracks
        } else {
          return []
        }
      })),
      Warnings: []
    }
    const max = Math.max(...sec.Tracks.map((track) => track.Meta.Duration))
    if (!sec.Tracks.every((track) => Math.abs(track.Meta.Duration - max) < EPSILON)) {
      sec.Warnings.push(new TmError(TmError.Types.Section.DiffDuration, [], { Expected: sec.Tracks.map(() => max), Actual: sec.Tracks.map((l) => l.Meta.Duration) }))
    }
    // const maxBarIni = Math.max(...sec.Tracks.map((track) => track.Meta.BarFirst))
    // const maxBarFin = Math.max(...sec.Tracks.map((track) => track.Meta.BarLast))
    // const ini = sec.Tracks.every((track) => track.Meta.BarFirst === maxBarIni)
    // const fin = sec.Tracks.every((track) => track.Meta.BarLast === maxBarFin)
    // FIXME: ini & fin
    // if (!ini) {
    //   sec.Warnings.push(new TmError(TmError.Types.Section.InitiativeBar, [], { Expected: maxBarIni, Actual: sec.Tracks.map((l) => l.Meta.BarFirst) }))
    // }
    // if (!fin && !Number.isNaN(maxBarFin)) {
    //   sec.Warnings.push(new TmError(TmError.Types.Section.FinalBar, [], { Expected: maxBarFin, Actual: sec.Tracks.map((l) => l.Meta.BarLast) }))
    // }
    // if (fin && this.sectionContext.PrevFin === undefined) {
    //   this.sectionContext.PrevFin = maxBarFin
    // } else if (fin && ini && maxBarIni !== settings.Bar && this.sectionContext.PrevFin + maxBarIni !== settings.Bar) {
    //   const expected = settings.Bar - this.sectionContext.PrevFin
    //   sec.Warnings.push(new TmError(TmError.Types.Section.Mismatch, [], { Expected: expected, Actual: sec.Tracks.map((l) => l.Meta.BarFirst) }))
    //   this.sectionContext.PrevFin = maxBarFin
    // }
    return sec
  }
}

module.exports = Parser
