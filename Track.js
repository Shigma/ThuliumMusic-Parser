const TmError = require('./Error')
const TmSetting = require('./Setting')
const { NoteParser, PitchParser } = require('./Note')

function equal(x, y) {
  return Math.abs(x - y) < 0.0000001
}

class TrackParser {
  constructor(track, instrument, sectionSettings, library) {
    this.ID = track.ID
    this.Instrument = instrument
    this.Library = library
    this.Content = track.Content
    this.Settings = sectionSettings.extend()
    this.Meta = {
      Index: -1,
      PitchQueue: [],
      BarFirst: 0,
      BarLast: 0,
      BarCount: 0,
      Duration: 0,
      After: {}
    }
    for (const attr in library.MetaInit) {
      if (library.MetaInit[attr] instanceof Array) {
        this.Meta[attr] = library.MetaInit[attr].slice()
      } else {
        this.Meta[attr] = library.MetaInit[attr]
      }
    }
    this.Notation = {}
    for (const name of library.Plugin.Classes) {
      this.Notation[name] = []
    }
    this.Warnings = []
  }

  pushError(errorType, args, useLocator = true) {
    this.Warnings.push(new TmError(errorType, useLocator ? {
      Bar: this.Meta.BarCount,
      Index: this.Meta.Index
    } : {}, args))
  }

  parseTrack() {
    this.Library.Pitch = {}
    this.Instrument.Dict.forEach(macro => {
      if (!(macro.Pitches instanceof Array)) {
        this.Library.Pitch[macro.Name] = Object.assign([{
          Pitch: macro.Pitches
        }], { Generated: true })
      } else if (macro.Pitches.Generated) {
        this.Library.Pitch[macro.Name] = macro.Pitches
      } else {
        const data = new PitchParser(
          { Pitch: macro.Pitches },
          this.Library,
          new TmSetting()
        ).checkParse()
        this.Library.Pitch[macro.Name] = data.Result
        if (data.Warnings.length > 0) {
          this.pushError('Library::PitchInit', { Warnings: data.Warnings }, false)
        }
      }
    })
    this.Content = [...this.Instrument.Spec, ...this.Content]
    const result = this.parseTrackContent()
    const terminal = this.Warnings.findIndex(err => {
      return err.name === 'Track::BarLength' && err.pos.Bar === this.Meta.BarCount
    })
    if (terminal > -1 && equal(this.Warnings[terminal].arg.Time, this.Meta.Duration)) {
      this.Warnings.splice(terminal, 1)
    }

    if (result.Meta.Duration < this.Settings.FadeIn) {
      this.pushError(TmError.Types.Track.FadeOverLong, { Actual: this.Settings.FadeIn }, false)
    }
    if (result.Meta.Duration < this.Settings.FadeOut) {
      this.pushError(TmError.Types.Track.FadeOverLong, { Actual: this.Settings.FadeOut }, false)
    }
    result.Effects = this.Settings.effects
    result.Instrument = this.Instrument.Name
    result.ID = this.ID ? `${this.ID}#${this.Instrument.Name}` : this.Instrument.Name
    return result
  }

  // FIXME: static?
  // FIXME: merge notation
  mergeMeta(dest, src) {
    this.Library.Plugin.proMerge(null, dest, src)
    dest.Meta.PitchQueue = src.Meta.PitchQueue
    dest.Warnings.push(...src.Warnings.map(warning => {
      warning.pos.unshift(Object.assign({}, {
        Bar: dest.Meta.BarCount,
        Index: dest.Meta.Index
      }))
      return warning
    }))
    if (src.Meta.BarCount === 0) {
      if (dest.Meta.BarCount === 0) {
        dest.Meta.BarFirst += src.Meta.BarFirst
        if (dest.isLegalBar(dest.Meta.BarFirst)) {
          dest.Meta.BarCount += 1
        }
      } else {
        dest.Meta.BarLast += src.Meta.BarFirst
        if (dest.isLegalBar(dest.Meta.BarLast)) {
          dest.Meta.BarLast = 0
        }
      }
    } else {
      if (dest.Meta.BarCount === 0) {
        dest.Meta.BarFirst += src.Meta.BarFirst
        dest.Meta.BarCount += 1
        dest.Meta.BarLast = src.Meta.BarLast
        if (dest.isLegalBar(dest.Meta.BarLast)) {
          dest.Meta.BarLast = 0
        }
      } else {
        dest.Meta.BarLast += src.Meta.BarFirst // problematic
        if (!dest.isLegalBar(dest.Meta.BarLast)) {
          dest.pushError(TmError.Types.Track.BarLength, {
            Expected: dest.Settings.Bar,
            Actual: dest.Meta.BarFirst
          })
        }
        dest.Meta.BarLast = src.Meta.BarLast
        if (dest.isLegalBar(dest.Meta.BarLast)) {
          dest.Meta.BarLast = 0
        }
      }
    }
    // FIXME: merge warnings
  }

  parseTrackContent(content = this.Content) {
    const result = []
    for (const token of content) {
      this.Meta.Index += 1
      switch (token.Type) {
      case 'Function':
      case 'Subtrack': 
      case 'Macrotrack': {
        let subtracks
        if (token.Type === 'Function') {
          subtracks = [this.Library.Package.applyFunction(this, token)]
          if (subtracks[0] === undefined) {
            break
            // FIXME: Test && Report Error ?
          }
        } else if (token.Type === 'Macrotrack') {
          if (token.Name in this.Library.Track) {
            subtracks = [new SubtrackParser({
              Type: 'Subtrack',
              Content: this.Library.Track[token.Name]
            }, this.Settings, this.Library, this.Meta).parseTrack()]
          } else {
            // FIXME: Report Error
            throw new Error(token.Name + ' not found')
          }
        } else {
          subtracks = new SubtrackParser(token, this.Settings, this.Library, this.Meta).parseTrack()
        }
        subtracks.forEach(subtrack => {
          this.mergeMeta(this, subtrack)
          subtrack.Content.forEach(note => {
            note.StartTime += this.Meta.Duration
          })
        })
        const max = Math.max(...subtracks.map(subtrack => subtrack.Meta.Duration))
        if (!subtracks.every(subtrack => equal(subtrack.Meta.Duration, max))) {
          this.Warnings.push(new TmError('Track::DiffDuration', {}, {
            Expected: subtracks.map(() => max),
            Actual: subtracks.map(subtrack => subtrack.Meta.Duration)
          }))
        }
        this.Meta.Duration += max
        result.push(...[].concat(...subtracks.map(subtrack => subtrack.Content)))
        break
      }
      case 'Note': {
        const note = new NoteParser(token, this.Library, this.Settings, this.Meta).parse()
        if (this.Meta.BarCount === 0) {
          this.Meta.BarFirst += note.Beat
        } else {
          this.Meta.BarLast += note.Beat
        }
        this.Warnings.push(...note.Warnings)
        result.push(...note.Result)
        break
      }
      case 'BarLine':
        if (this.Meta.BarLast > 0) {
          this.Meta.BarCount += 1
        }
        if (!this.isLegalBar(this.Meta.BarLast)) {
          this.pushError(TmError.Types.Track.BarLength, {
            Expected: this.Settings.Bar,
            Actual: this.Meta.BarLast,
            Time: this.Meta.Duration
          })
        }
        this.Meta.BarLast = 0
        break
      case 'Clef':
      case 'Comment':
      case 'Space':
        break
      default:
        const attributes = this.Library.Types[token.Type]
        if (attributes.preserve) {
          this.Notation[attributes.class].push({
            Type: token.Type,
            Bar: this.Meta.BarCount,
            Index: this.Meta.Index,
            Time: this.Meta.Duration
          })
        }
        this.Meta.After[token.Type] = true
      }
    }
    this.Library.Plugin.epiTrack(this)
    const returnObj = {
      Notation: this.Notation,
      Content: result,
      Warnings: this.Warnings,
      Settings: this.Settings,
      Meta: this.Meta
    }
    return returnObj
  }

  isLegalBar(bar) {
    return bar === undefined || equal(bar, this.Settings.Bar) || bar === 0
  }
}

class SubtrackParser extends TrackParser {
  constructor(track, settings, library, { PitchQueue = [] }) {
    super(track, null, settings, library)
    this.Meta.PitchQueue = PitchQueue
    this.Repeat = track.Repeat
  }

  parseTrack() {
    this.preprocess()

    // FIXME: overlay security
    const results = []
    let lastIndex = 0
    this.Content.forEach((token, index) => {
      if (token.Type === 'BarLine' && token.Overlay) {
        results.push(this.parseTrackContent(this.Content.slice(lastIndex, index)))
        lastIndex = index + 1
        this.Meta.Duration = 0 // FIXME: this.Settings
      }
    })
    results.push(this.parseTrackContent(this.Content.slice(lastIndex)))
    return results
  }

  preprocess() {
    if (this.Repeat === undefined) this.Repeat = -1
    if (this.Repeat > 0) {
      this.Content.forEach((token, index) => {
        if (token.Type === 'BarLine' && token.Skip) {
          this.Warnings.push(new TmError(TmError.Types.Track.UnexpCoda, { Index: index }, { Actual: token }))
        }
      })
      const temp = []
      const repeatArray = this.Content.filter(token => token.Type === 'BarLine' && token.Order[0] !== 0)
      const defaultOrder = repeatArray.find(token => token.Order.length === 0)
      if (defaultOrder !== undefined) {
        const order = [].concat(...repeatArray.map((token) => token.Order))
        for (let i = 1; i < this.Repeat; i++) {
          if (order.indexOf(i) === -1) defaultOrder.Order.push(i)
        }
      }
      for (let i = 1; i <= this.Repeat; i++) {
        let skip = false
        for (const token of this.Content) {
          if (token.Type !== 'BarLine' || token.Order[0] === 0) {
            if (!skip) {
              temp.push(token)
            }
          } else if (token.Order.indexOf(i) === -1) {
            skip = true
          } else {
            skip = false
            temp.push(token)
          }
        }
        temp.push({
          Type: 'BarLine',
          Skip: false,
          Order: [0]
        })
      }
      this.Content = temp
    } else {
      this.Content.forEach((token, index) => {
        if (token.Order instanceof Array && (token.Order.length !== 1 || token.Order[0] !== 0)) {
          this.Warnings.push(new TmError(TmError.Types.Track.UnexpVolta, { index }, { Actual: token }))
        }
      })
      if (this.Repeat !== -1 && this.Content.length >= 1) {
        const last = this.Content[this.Content.length - 1]
        if (last.Type !== 'BarLine') {
          this.Content.push({
            Type: 'BarLine',
            Skip: false,
            Order: [0]
          })
        }
      }
      const skip = this.Content.findIndex((tok) => tok.Skip === true)
      for (let index = skip + 1, length = this.Content.length; index < length; index++) {
        if (this.Content[index].Skip === true) {
          this.Warnings.push(new TmError(TmError.Types.Track.MultiCoda, { index }, {}))
        }
      }
      let temp
      if (skip === -1) {
        temp = new Array(-this.Repeat).fill(this.Content)
      } else {
        temp = new Array(-this.Repeat - 1).fill(this.Content)
        temp.push(this.Content.slice(0, skip))
      }
      this.Content = [].concat(...temp)
    }
  }
}

module.exports = {
  TrackParser,
  SubtrackParser
}
