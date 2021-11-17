import proxyquire from 'proxyquire'
import sinon, { SinonSpy } from 'sinon'
import cheerio from 'cheerio'
// lib
import { Crawler, CrawlerOptions } from '@/core/crawler'
import { userAgent, hash } from '_u/helper'

// types
interface dbStub {
    batch: SinonSpy
    put: SinonSpy
}
interface Context {
    db: (name?: string) => {
        batch: SinonSpy
        put: SinonSpy
    }
}
interface Rank {
    name?: string
    url?: string
    position?: number
    type?: string
    id?: string
}

// stubs
let CrawlerStub: typeof Crawler, fsStub, getDB: SinonSpy, followStub: SinonSpy

// 创建爬虫
function createCrawler(options: CrawlerOptions<Context>) {
    var opts: CrawlerOptions<Context> = {
        name: 'douban',
        bloom: false, // 禁用bloom过滤
        interval: () => (Math.random() * 2 + 1) * 1000, // 随机间隔 1~3s
    }
    var crawler = new CrawlerStub(Object.assign(opts, options))

    // random-useragent
    crawler.request('headers', async (context) => {
        let { req } = context

        Object.assign(req.headers, {
            'Cache-Control': 'no-cache',
            'User-Agent': userAgent(),
            Accept: '*/*',
            'Accept-Encoding': 'gzip, deflate, compress', // 目前只支持这3种，其它会乱码
            Connection: 'keep-alive',
        })
        // db
        context.db = getDB
        // stub followLinks
        followStub = context.followLinks = sinon.fake()
    })

    return crawler
}

describe('entry', function () {
    this.timeout(8000)

    beforeEach(function () {
        fsStub = {
            writeFileSync: sinon.fake(),
            mkdirSync: sinon.fake(),
            existsSync: sinon.fake(),
        }
        getDB = sinon.fake((name = '') => ({
            batch: sinon.fake((k, v) => Promise.resolve([name + k, v])),
            put: sinon.fake((k, v) => Promise.resolve([name + k, v])),
        }))
        CrawlerStub = proxyquire('@/core/crawler', {
            fs: fsStub,
        }).Crawler
    })

    // top排行榜
    it('top', function (done) {
        var douban = createCrawler({
                startUrls: ['https://movie.douban.com/chart'],
            }),
            spider = douban.use({
                path: '/chart',
                async success(context) {
                    let { res } = context,
                        $ = cheerio.load(res.body.toString()),
                        dbRank = context.db('rank'),
                        rankList = []

                    // 新片榜
                    $('h2:contains("新片榜")<div .item').each(function (index) {
                        var rank: Rank = {},
                            $item = $(this)

                        rank.name = $('.pl2 a', $item)
                            .text()
                            .replace(/\s+/g, ' ')
                            .trim()
                        rank.url = $('.pl2 a', $item).attr('href')
                        rank.position = index + 1
                        rank.type = 'new'
                        rank.id = hash(rank.url)

                        rankList.push(rank)
                    })

                    // 一周口碑榜
                    $('h2:contains("一周")<div li').each(function (index) {
                        var rank: Rank = {},
                            $item = $(this)

                        rank.name = $('a', $item)
                            .text()
                            .replace(/\s+/g, ' ')
                            .trim()
                        rank.url = $('a', $item).attr('href')
                        rank.position = index + 1
                        rank.type = 'week'
                        rank.id = hash(rank.url)

                        rankList.push(rank)
                    })

                    // 北美票房榜
                    $('h2:contains("北美")<div li').each(function (index) {
                        var rank: Rank = {},
                            $item = $(this)

                        rank.name = $('a', $item)
                            .text()
                            .replace(/\s+/g, ' ')
                            .trim()
                        rank.url = $('a', $item).attr('href')
                        rank.position = index + 1
                        rank.type = 'na'
                        rank.id = hash(rank.url)

                        rankList.push(rank)
                    })

                    if (rankList.length) {
                        // 批量存储
                        await dbRank.batch(
                            rankList.map((v) => ({
                                type: 'put',
                                key: v.id,
                                value: v,
                            }))
                        )

                        // 电影详情
                        context.followLinks(rankList.map((v) => v.url))

                        // 分类排行榜
                        let root = context.db(),
                            typeRankMap = {}

                        $('h2:contains("分类排行榜")<div .types a').each(
                            function (index) {
                                let $a = $(this),
                                    url = $a.attr('href'),
                                    params = new URL(context.resolveLink(url))
                                        .searchParams

                                typeRankMap[params.get('type')] =
                                    params.get('type_name')

                                context.followLinks(
                                    `https://movie.douban.com/j/chart/top_list?type=${params.get(
                                        'type'
                                    )}&interval_id=100%3A90&action=&start=20&limit=20`
                                )
                            }
                        )
                        //// 分类词典
                        await root.put('typeRankMap', typeRankMap)
                    }
                },
            })

        spider.download('test', async () => {
            try {
                let dbRank: dbStub = getDB.firstCall.returnValue,
                    dbRoot: dbStub = getDB.secondCall.returnValue

                let rankList: Array<Rank> = dbRank.batch.firstCall.firstArg.map(
                    (v) => v.value
                )
                rankList.should.lengthOf(30)
                rankList.forEach((v) => {
                    v.url.should.contains('https://movie.douban.com/subject/')
                    v.name.should.lengthOf.above(0)
                    v.type.should.oneOf(['new', 'week', 'na'])
                    v.position.should.within(1, 10)
                    v.id.should.lengthOf.above(0)
                })

                let typeRankMap = dbRoot.put.firstCall.lastArg
                typeRankMap.should.eql({
                    11: '剧情',
                    24: '喜剧',
                    5: '动作',
                    13: '爱情',
                    17: '科幻',
                    25: '动画',
                    10: '悬疑',
                    19: '惊悚',
                    20: '恐怖',
                    1: '纪录片',
                    23: '短片',
                    6: '情色',
                    26: '同性',
                    14: '音乐',
                    7: '歌舞',
                    28: '家庭',
                    8: '儿童',
                    2: '传记',
                    4: '历史',
                    22: '战争',
                    3: '犯罪',
                    27: '西部',
                    16: '奇幻',
                    15: '冒险',
                    12: '灾难',
                    29: '武侠',
                    30: '古装',
                    18: '运动',
                    31: '黑色电影',
                })
                done()
            } catch (err) {
                done(err)
            }
        })

        douban.run()
    })

    it('skip', function (done) {
        var douban = createCrawler({
            startUrls: [
                'https://movie.douban.com/subject/25804480/', // 404
            ],
            async fail(err: Error, context) {
                context.skip(context.req)
                context.req.state.should.eql('failed')
            },
        })

        douban.on('done', ({ reqCount, downloadCount, failedCount }) => {
            reqCount.should.eql(1)
            downloadCount.should.eql(0)
            failedCount.should.eql(1)

            done()
        })

        douban.run()
    })

    it('defer', function (done) {
        var douban = createCrawler({
            startUrls: [
                'https://movie.douban.com/subject/25860925/', // 404
            ],
            async fail(err: Error, context) {
                let { req } = context
                // 重试2次后跳过
                req.retryTimes >= 2 ? context.skip(req) : context.defer(req)
            },
        })

        douban.on('done', ({ reqCount, downloadCount, failedCount }) => {
            reqCount.should.eql(3)
            downloadCount.should.eql(0)
            failedCount.should.eql(3)

            done()
        })

        douban.run()
    })

    it('sleep', function (done) {
        this.timeout(20 * 1000) // 20s
        let startTime = Date.now()

        var douban = createCrawler({
            startUrls: [
                'https://movie.douban.com/subject/25860925/', // 404
            ],
            async fail(err: Error, context) {
                let { req } = context
                // 休息10s后再爬取
                if (req.retryTimes >= 1) {
                    context.skip(req)
                } else {
                    context.defer(req)
                    context.sleep(10 * 1000)
                }
            },
        })

        douban.on('done', ({ reqCount, downloadCount, failedCount }) => {
            reqCount.should.eql(2)
            downloadCount.should.eql(0)
            failedCount.should.eql(2)

            var duration = Date.now() - startTime
            // 至少过了10s
            duration.should.gte(10 * 1000)
            done()
        })

        douban.run()
    })
})
