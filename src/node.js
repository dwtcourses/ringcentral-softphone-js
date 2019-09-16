import WebSocket from 'isomorphic-ws'
import uuid from 'uuid/v4'
import fs from 'fs'
import RingCentral from '@ringcentral/sdk'
import { RTCSessionDescription, RTCPeerConnection, nonstandard } from 'wrtc'

import { generateAuthorization } from './utils'
import RcMessage from './RcMessage'
import RequestSipMessage from './SipMessage/outbound/RequestSipMessage'
import InboundSipMessage from './SipMessage/inbound/InboundSipMessage'
import ResponseSipMessage from './SipMessage/outbound/ResponseSipMessage'

const RTCAudioSink = nonstandard.RTCAudioSink

const fakeDomain = uuid() + '.invalid'
const fakeEmail = uuid() + '@' + fakeDomain
const branch = () => 'z9hG4bK' + uuid()
const fromTag = uuid()
const toTag = uuid()
const callerId = uuid()

let ws
let sipInfo

const send = async sipMessage => {
  return new Promise((resolve, reject) => {
    if (sipMessage.subject.startsWith('SIP/2.0 ')) { // response message, no waiting for response from server side
      ws.send(sipMessage.toString())
      resolve(undefined)
      return
    }
    const messageHandler = event => {
      const inboundSipMessage = InboundSipMessage.fromString(event.data)
      if (inboundSipMessage.headers.CSeq !== sipMessage.headers.CSeq) {
        return // message not for this send
      }
      if (inboundSipMessage.subject === 'SIP/2.0 100 Trying') {
        return // ignore
      }
      ws.removeEventListener('message', messageHandler)
      resolve(inboundSipMessage)
    }
    ws.addEventListener('message', messageHandler)
    ws.send(sipMessage.toString())
  })
}

const openHandler = async (event) => {
  ws.removeEventListener('open', openHandler)
  const requestSipMessage = new RequestSipMessage(`REGISTER sip:${sipInfo.domain} SIP/2.0`, {
    CSeq: '8145 REGISTER',
    'Call-ID': callerId,
    Contact: `<sip:${fakeEmail};transport=ws>;expires=600`,
    From: `<sip:${sipInfo.username}@${sipInfo.domain}>;tag=${fromTag}`,
    To: `<sip:${sipInfo.username}@${sipInfo.domain}>`,
    Via: `SIP/2.0/WSS ${fakeDomain};branch=${branch()}`
  })
  let inboundSipMessage = await send(requestSipMessage)
  const wwwAuth = inboundSipMessage.headers['Www-Authenticate']
  if (wwwAuth && wwwAuth.includes(', nonce="')) { // authorization required
    const nonce = wwwAuth.match(/, nonce="(.+?)"/)[1]
    requestSipMessage.headers.Authorization = generateAuthorization(sipInfo, 'REGISTER', nonce)
    inboundSipMessage = await send(requestSipMessage)
    if (inboundSipMessage.subject === 'SIP/2.0 200 OK') { // register successful
      ws.addEventListener('message', inviteHandler)
    }
  }
}

const inviteHandler = async (event) => {
  const inboundSipMessage = InboundSipMessage.fromString(event.data)
  if (inboundSipMessage.subject.startsWith('INVITE sip:')) {
    ws.removeEventListener('message', inviteHandler) // todo: can accept one and only one call
    await send(new ResponseSipMessage(inboundSipMessage, 100, 'Trying', {
      To: inboundSipMessage.headers.To
    }))
    await send(new ResponseSipMessage(inboundSipMessage, 180, 'Ringing', {
      To: `${inboundSipMessage.headers.To};tag=${toTag}`,
      Contact: `<sip:${fakeDomain};transport=ws>`
    }))

    const sdp = inboundSipMessage.body
    const rcMessage = RcMessage.fromXml(inboundSipMessage.headers['P-rc'])
    const newRcMessage = new RcMessage(
      {
        SID: rcMessage.Hdr.SID,
        Req: rcMessage.Hdr.Req,
        From: rcMessage.Hdr.To,
        To: rcMessage.Hdr.From,
        Cmd: 17
      },
      {
        Cln: sipInfo.authorizationId
      }
    )
    const newMsgStr = newRcMessage.toXml()
    const requestSipMessage = new RequestSipMessage(`MESSAGE sip:${rcMessage.Hdr.From.replace('#', '%23')} SIP/2.0`, {
      Via: `SIP/2.0/WSS ${fakeEmail};branch=${branch()}`,
      To: `<sip:${rcMessage.Hdr.From.replace('#', '%23')}>`,
      From: `<sip:${rcMessage.Hdr.To}@sip.ringcentral.com>;tag=${fromTag}`,
      'Call-ID': callerId,
      'Content-Type': 'x-rc/agent'
    }, newMsgStr)
    await send(requestSipMessage)

    const remoteRtcSd = new RTCSessionDescription({ type: 'offer', sdp })
    const rtcpc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:74.125.194.127:19302' }] })

    rtcpc.addEventListener('track', e => {
      const audioSink = new RTCAudioSink(e.track)

      const audioPath = 'audio.raw'
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath)
      }
      const stream = fs.createWriteStream(audioPath, { flags: 'a' })
      audioSink.ondata = data => {
        stream.write(Buffer.from(data.samples.buffer))
      }
      const byeHandler = e => {
        if (e.data.startsWith('BYE ')) {
          ws.removeEventListener('message', byeHandler)
          audioSink.stop()
          stream.end()
        }
      }
      ws.addEventListener('message', byeHandler)
    })

    rtcpc.setRemoteDescription(remoteRtcSd)
    const localRtcSd = await rtcpc.createAnswer()
    rtcpc.setLocalDescription(localRtcSd)

    await send(new ResponseSipMessage(inboundSipMessage, 200, 'OK', {
      To: `${inboundSipMessage.headers.To};tag=${toTag}`,
      Contact: `<sip:${fakeEmail};transport=ws>`,
      'Content-Type': 'application/sdp'
    }, localRtcSd.sdp))
    ws.addEventListener('message', takeOverHandler)
  }
}

const takeOverHandler = async event => {
  const inboundSipMessage = InboundSipMessage.fromString(event.data)
  if (inboundSipMessage.subject.startsWith('MESSAGE ') && inboundSipMessage.body.includes(' Cmd="7"')) {
    ws.removeEventListener('message', takeOverHandler)
    await send(new ResponseSipMessage(inboundSipMessage, 200, 'OK', {
      To: `${inboundSipMessage.headers.To};tag=${toTag}`
    }))
  }
}

const rc = new RingCentral({
  server: process.env.RINGCENTRAL_SERVER_URL,
  clientId: process.env.RINGCENTRAL_CLIENT_ID,
  clientSecret: process.env.RINGCENTRAL_CLIENT_SECRET
})

;(async () => {
  await rc.login({
    username: process.env.RINGCENTRAL_USERNAME,
    extension: process.env.RINGCENTRAL_EXTENSION,
    password: process.env.RINGCENTRAL_PASSWORD
  })
  const r = await rc.post('/restapi/v1.0/client-info/sip-provision', {
    sipInfo: [{ transport: 'WSS' }]
  })
  await rc.logout()
  const json = await r.json()
  sipInfo = json.sipInfo[0]
  ws = new WebSocket('wss://' + sipInfo.outboundProxy, 'sip')
  ws.addEventListener('open', openHandler)

  /* this is for debugging - start */
  ws.addEventListener('message', event => {
    console.log('\n***** WebSocket Got - start *****')
    console.log(event.data)
    console.log('***** WebSocket Got - end *****\n')
  })
  const send = ws.send.bind(ws)
  ws.send = (...args) => {
    console.log('\n***** WebSocket Send - start *****')
    console.log(...args)
    console.log('***** WebSocket Send - end *****\n')
    send(...args)
  }
  /* this is for debugging - end */
})()
