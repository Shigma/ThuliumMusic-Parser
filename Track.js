const TmError = require('./Error')
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
      NotesBeforeTie: [],
      PitchQueue: [],
      BarFirst: 0,
      BarLast: 0,
      Duration: 0,
      BarCount: 0,
      TieLeft: false,
      TieRight: false
    }
    this.Notation = {}
    for (const name of library.Plugin.Classes) {
      this.Notation[name] = []
    }
    this.Result = []
    this.Warnings = []
  }

  pushError(errorType, args, useLocator = true) {
    this.Warnings.push(new TmError(errorType, useLocator ? {
      Bar: this.Meta.BarCount,
      Index: this.Meta.Index
    } : null, args))
  }

  parseTrack() {
    this.Library.Pitch = this.Instrument.Dict
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
    dest.Meta.PitchQueue.push(...src.Meta.PitchQueue)
    dest.Meta.Duration += src.Meta.Duration
    dest.Meta.NotesBeforeTie = src.Meta.NotesBeforeTie
    dest.Meta.TieLeft = src.Meta.TieLeft
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
  }

  parseTrackContent() {
    for (const token of this.Content) {
      this.Meta.Index += 1
      switch (token.Type) {
      case 'Function':
      case 'Subtrack': 
      case 'Macrotrack': {
        let subtrack
        if (token.Type === 'Function') {
          subtrack = this.Library.Package.applyFunction(this, token)
          if (subtrack === undefined) {
            break
          }
        } else if (token.Type === 'Macrotrack') {
          if (token.Name in this.Library.Track) {
            subtrack = new SubtrackParser({
              Type: 'Subtrack',
              Content: this.Library.Track[token.Name]
            }, this.Settings, this.Library, this.Meta).parseTrack()
          } else {
            throw new Error(token.Name + ' not found')
          }
        } else {
          subtrack = new SubtrackParser(token, this.Settings, this.Library, this.Meta).parseTrack()
        }
        subtrack.Content.forEach((tok) => {
          if (tok.Type === 'Note') {
            tok.StartTime += this.Meta.Duration
          }
        })
        this.mergeMeta(this, subtrack)
        this.Result.push(...subtrack.Content)
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
        this.Result.push(...note.Result)
        break
      }
      case 'Tie':
        this.Meta.TieLeft = true
        break
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
        // FIXME: overlay
        if (token.Overlay) {
          this.Meta.Duration = 0
        }
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
      Content: this.Result,
      Warnings: this.Warnings,
      Settings: this.Settings,
      Meta: Object.assign(this.Meta, { PitchQueue: this instanceof SubtrackParser ? this.Meta.PitchQueue.slice(this.oriPitchQueueLength) : this.Meta.PitchQueue })
    }
    return returnObj
  }

  isLegalBar(bar) {
    return bar === undefined || equal(bar, this.Settings.Bar) || bar === 0
  }
}

class SubtrackParser extends TrackParser {
  constructor(track, settings, library, { PitchQueue: pitchQueue, NotesBeforeTie: notesBeforeTie, TieLeft: tieLeft }) {
    super(track, null, settings, library)
    this.Repeat = track.Repeat
    if (pitchQueue === undefined) {
      this.Meta.PitchQueue = []
      this.oriPitchQueueLength = 0
    } else {
      this.Meta.PitchQueue = pitchQueue.slice()
      this.oriPitchQueueLength = pitchQueue.length
    }
    if (notesBeforeTie !== null) {
      this.Meta.NotesBeforeTie = notesBeforeTie
    }
    if (tieLeft !== null) {
      this.Meta.TieLeft = tieLeft
    }
  }

  parseTrack() {
    this.preprocess()
    const trackResult = this.parseTrackContent(this.Content)
    return trackResult
  }

  preprocess() {
    if (this.Repeat === undefined) this.Repeat = -1
    if (this.Repeat > 0) {
      this.Content.forEach((token, index) => {
        if (token.Skip === true) {
          this.Warnings.push(new TmError(TmError.Types.Track.UnexpCoda, { index }, { Actual: token }))
        }
      })
      const temp = []
      const repeatArray = this.Content.filter((token) => token.Type === 'BarLine' && token.Order[0] !== 0)
      const defaultOrder = repeatArray.find((token) => token.Order.length === 0)
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
