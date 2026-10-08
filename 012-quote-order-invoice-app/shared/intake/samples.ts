// FreelanceDesk ヒアリング — サンプルテンプレート（IntakeMint src/shared/sampleTemplates.ts から移植）。
// 変更点：FreelanceDesk の添付許可形式に合わせ svg / eps / zip を除外（ai は PDF 互換保存のもののみ受付）、上限は 10MB。
// サンプルは出発点であり、業種ごとの法的必要書類を保証しない。
import {
  DEFAULT_COMPLETION_RULES, DEFAULT_REMINDER_POLICY, type HandoffProfile, type PackageTemplate, type Question,
  type RequiredItem, type Rule, type Section, type TemplateDefinition,
} from './types'

export interface SampleTemplate {
  key: string
  name: string
  description: string
  industry: string
  definition: TemplateDefinition
}

function def(p: {
  sections: Section[]; questions: Question[]; rules?: Rule[]; requiredItems: RequiredItem[]; profile: HandoffProfile
  mapping?: PackageTemplate['mapping']; intro?: string
}): TemplateDefinition {
  return {
    sections: p.sections, questions: p.questions, rules: p.rules ?? [], requiredItems: p.requiredItems,
    completionRules: { ...DEFAULT_COMPLETION_RULES }, reminderPolicy: { ...DEFAULT_REMINDER_POLICY, quietHours: { ...DEFAULT_REMINDER_POLICY.quietHours } },
    packageTemplate: { profile: p.profile, mapping: p.mapping ?? {} }, hiddenAnswerPolicy: 'retain_excluded',
    intro: p.intro ?? 'お仕事を始めるために必要な情報とファイルをお送りください。途中で保存して、後から続きを入力できます。',
    completionMessage: 'ご提出ありがとうございました。担当者が内容を確認し、追加で必要なものがあればご連絡します。',
  }
}

const IMG = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']
const DOCS = ['pdf', 'docx', 'xlsx', 'txt', 'csv']

export const webTemplate: SampleTemplate = {
  key: 'web', name: 'Web制作（コーポレートサイト）', industry: 'web',
  description: 'コーポレートサイト・ECサイト制作の開始に必要な情報とファイルを回収します。',
  definition: def({
    profile: 'web_development',
    sections: [
      { id: 's_company', title: '会社情報' },
      { id: 's_site', title: 'サイトの目的・内容' },
      { id: 's_ec', title: 'EC（ネット販売）について' },
      { id: 's_recruit', title: '採用ページについて' },
      { id: 's_assets', title: 'ロゴ・画像・参考サイト' },
      { id: 's_contact', title: 'ご連絡先' },
    ],
    questions: [
      { id: 'company_name', sectionId: 's_company', type: 'short_text', label: '会社名', required: true },
      { id: 'company_address', sectionId: 's_company', type: 'short_text', label: '所在地', required: true },
      { id: 'company_url', sectionId: 's_company', type: 'url', label: '現在のWebサイト（あれば）' },
      { id: 'ceo_message', sectionId: 's_company', type: 'long_text', label: '代表挨拶の文章', help: '300〜600字程度が目安です。下書きでも構いません。', required: true },
      { id: 'site_purpose', sectionId: 's_site', type: 'multiple_choice', label: 'サイトに必要な機能', required: true,
        options: [
          { value: 'company', label: '会社案内' }, { value: 'inquiry', label: 'お問い合わせ獲得' },
          { value: 'ec', label: 'ネット販売（EC）' }, { value: 'recruit', label: '採用' }, { value: 'blog', label: 'お知らせ・ブログ' },
        ] },
      { id: 'site_goal', sectionId: 's_site', type: 'long_text', label: 'サイトで一番達成したいことは何ですか？', required: true, tags: ['objective'] },
      { id: 'business_description', sectionId: 's_site', type: 'long_text', label: '事業内容', required: true },
      { id: 'target_audience', sectionId: 's_site', type: 'long_text', label: '主なお客様（ターゲット）', tags: ['audience'] },
      { id: 'requests', sectionId: 's_site', type: 'long_text', label: 'ご要望・詳細', tags: ['preferences'] },
      { id: 'launch_date', sectionId: 's_site', type: 'date', label: '公開希望日', tags: ['constraints'] },
      { id: 'budget_note', sectionId: 's_site', type: 'short_text', label: 'ご予算・制約事項（任意）', tags: ['constraints'] },
      { id: 'ec_product_count', sectionId: 's_ec', type: 'number', label: '掲載する商品数', min: 0, max: 100000, visibleByDefault: false },
      { id: 'ec_payment', sectionId: 's_ec', type: 'multiple_choice', label: '希望する決済方法', visibleByDefault: false,
        options: [{ value: 'card', label: 'クレジットカード' }, { value: 'bank', label: '銀行振込' }, { value: 'cod', label: '代金引換' }, { value: 'qr', label: 'QR・コード決済' }] },
      { id: 'ec_shipping', sectionId: 's_ec', type: 'long_text', label: '配送方法・送料の考え方', visibleByDefault: false },
      { id: 'ec_membership', sectionId: 's_ec', type: 'yes_no', label: '会員登録機能は必要ですか？', visibleByDefault: false },
      { id: 'recruit_positions', sectionId: 's_recruit', type: 'long_text', label: '募集職種', visibleByDefault: false },
      { id: 'recruit_flow', sectionId: 's_recruit', type: 'long_text', label: '応募から面接までの流れ', visibleByDefault: false },
      { id: 'logo_q', sectionId: 's_assets', type: 'file', label: 'ロゴデータ（PDF / PNG / AI（PDF互換））', fileItemId: 'logo' },
      { id: 'product_images_q', sectionId: 's_assets', type: 'image', label: '商品・サービス画像（5枚）', fileItemId: 'product_images' },
      { id: 'reference_sites', sectionId: 's_assets', type: 'repeating_group', label: '参考サイト', required: true, minRows: 1, maxRows: 10,
        fields: [{ id: 'url', label: 'URL', type: 'url' }, { id: 'reason', label: '参考にしたい点', type: 'short_text' }] },
      { id: 'contact_name', sectionId: 's_contact', type: 'short_text', label: 'ご担当者名', required: true },
      { id: 'contact_email', sectionId: 's_contact', type: 'email', label: 'メールアドレス', required: true },
      { id: 'contact_phone', sectionId: 's_contact', type: 'phone', label: '電話番号' },
      { id: 'privacy_ack', sectionId: 's_contact', type: 'acknowledgement', label: '提出内容を制作目的に利用することに同意します', required: true },
    ],
    rules: [
      { id: 'r_ec', description: 'EC選択時にEC専用質問を表示・必須化', when: { questionId: 'site_purpose', op: 'contains', value: 'ec' },
        then: [
          { type: 'show', target: 'ec_product_count' }, { type: 'require', target: 'ec_product_count' },
          { type: 'show', target: 'ec_payment' }, { type: 'require', target: 'ec_payment' },
          { type: 'show', target: 'ec_shipping' }, { type: 'show', target: 'ec_membership' },
        ] },
      { id: 'r_recruit', description: '採用選択時に採用質問を表示', when: { questionId: 'site_purpose', op: 'contains', value: 'recruit' },
        then: [{ type: 'show', target: 'recruit_positions' }, { type: 'require', target: 'recruit_positions' }, { type: 'show', target: 'recruit_flow' }] },
    ],
    requiredItems: [
      { id: 'company_info', label: '会社情報', type: 'question', required: true, questionIds: ['company_name', 'company_address'] },
      { id: 'logo', label: 'ロゴデータ', type: 'file', required: true, minCount: 1, maxCount: 5, acceptedFormats: ['ai', 'pdf', 'png'], maxSizeMB: 10, requireReview: true, category: 'brand', notes: 'できればベクター形式（PDF、またはPDF互換で保存したAI）' },
      { id: 'greeting', label: '代表挨拶', type: 'question', required: true, questionIds: ['ceo_message'] },
      { id: 'business', label: '事業内容', type: 'question', required: true, questionIds: ['business_description', 'site_purpose', 'site_goal'] },
      { id: 'product_images', label: '商品・サービス画像', type: 'file', required: true, minCount: 5, maxCount: 30, acceptedFormats: IMG, maxSizeMB: 10, requireReview: true, category: 'product' },
      { id: 'references', label: '参考サイト', type: 'question', required: true, questionIds: ['reference_sites'] },
      { id: 'contact', label: 'ご連絡先', type: 'question', required: true, questionIds: ['contact_name', 'contact_email', 'privacy_ack'] },
    ],
    mapping: {
      client: ['company_name', 'company_address', 'company_url', 'contact_name', 'contact_email', 'contact_phone'],
      project: ['site_purpose', 'launch_date'],
      objective: ['site_goal'],
      audience: ['target_audience'],
      requirements: ['site_purpose', 'business_description', 'ceo_message', 'ec_product_count', 'ec_payment', 'ec_shipping', 'ec_membership', 'recruit_positions', 'recruit_flow'],
      preferences: ['requests'],
      references: ['reference_sites'],
      constraints: ['launch_date', 'budget_note'],
    },
  }),
}

function simple(key: string, name: string, industry: string, profile: HandoffProfile, description: string,
  qs: Array<[string, Question['type'], string, boolean?, Partial<Question>?]>, files: Array<[string, string, number, string[], RequiredItem['category']]>): SampleTemplate {
  const questions: Question[] = qs.map(([id, type, label, required, extra]) => ({ id, sectionId: 's_main', type, label, required: !!required, ...(extra ?? {}) }))
  for (const [id, label] of files) questions.push({ id: `${id}_q`, sectionId: 's_files', type: 'file', label, fileItemId: id })
  const requiredItems: RequiredItem[] = files.map(([id, label, min, fmts, category]) => ({
    id, label, type: 'file', required: true, minCount: min, acceptedFormats: fmts, maxSizeMB: 10, requireReview: true, category,
  }))
  return {
    key, name, industry, description,
    definition: def({ profile, sections: [{ id: 's_main', title: '基本情報' }, { id: 's_files', title: '提出ファイル' }], questions, requiredItems,
      mapping: { client: [qs[0][0]], objective: qs.filter((q) => q[4]?.tags?.includes('objective')).map((q) => q[0]), requirements: qs.map((q) => q[0]) } }),
  }
}

export const sampleTemplates: SampleTemplate[] = [
  webTemplate,
  simple('ec', 'EC立ち上げ・出店支援', 'ec', 'web_development', 'ネットショップ立ち上げや出店に必要な商品情報・画像・事業者情報を回収します。', [
    ['shop_name', 'short_text', 'ショップ名', true], ['product_count', 'number', '商品数', true, { min: 0 }],
    ['payment', 'multiple_choice', '決済方法', true, { options: [{ value: 'card', label: 'クレジットカード' }, { value: 'bank', label: '銀行振込' }, { value: 'cod', label: '代引き' }] }],
    ['shipping', 'long_text', '配送・送料', true], ['goal', 'long_text', '売上目標・目的', false, { tags: ['objective'] }],
  ], [['ec_product_images', '商品画像', 5, IMG, 'product'], ['ec_product_list', '商品一覧（CSV/Excel）', 1, ['csv', 'xlsx'], 'product']]),
  simple('sns', 'SNS運用代行', 'sns', 'sns_management', 'SNS運用開始に必要なアカウント情報（パスワードは送らない）、トンマナ、素材を回収します。', [
    ['brand_name', 'short_text', 'ブランド名', true],
    ['platforms', 'multiple_choice', '運用するSNS', true, { options: [{ value: 'instagram', label: 'Instagram' }, { value: 'x', label: 'X' }, { value: 'tiktok', label: 'TikTok' }, { value: 'line', label: 'LINE' }] }],
    ['tone', 'long_text', '投稿のトーン＆マナー', true], ['kpi', 'long_text', '目標（フォロワー・問い合わせ等）', false, { tags: ['objective'] }],
    ['no_password_ack', 'acknowledgement', 'パスワードはこのフォームに入力しないことを確認しました', true],
  ], [['sns_brand_assets', 'ロゴ・ブランド素材', 1, ['ai', 'png', 'pdf'], 'brand'], ['sns_photos', '投稿用写真素材', 10, IMG, 'product']]),
  simple('video', '動画制作', 'video', 'video', '動画制作の構成・尺・素材・納品形式を回収します。', [
    ['video_purpose', 'long_text', '動画の目的', true, { tags: ['objective'] }], ['duration', 'short_text', '尺（例：60秒）', true],
    ['deliver_format', 'multiple_choice', '納品形式', true, { options: [{ value: '16x9', label: '横（16:9）' }, { value: '9x16', label: '縦（9:16）' }, { value: '1x1', label: '正方形' }] }],
    ['deadline', 'date', '納品希望日', true],
  ], [['video_materials', '撮影素材・写真', 3, [...IMG, 'mp4', 'mov'], 'product'], ['video_logo', 'ロゴデータ', 1, ['ai', 'png', 'pdf'], 'brand']]),
  simple('recruit', '採用・人事（応募書類回収）', 'recruiting', 'recruiting', '採用選考・入社手続きの書類を回収します。本人確認の真正性は保証しません。', [
    ['position', 'short_text', '応募職種', true], ['candidate_name', 'short_text', '氏名', true], ['candidate_email', 'email', 'メールアドレス', true],
    ['available_from', 'date', '入社可能日'],
  ], [['resume', '履歴書・職務経歴書', 1, ['pdf', 'docx'], 'company']]),
  simple('consulting', 'コンサルティング開始', 'consulting', 'consulting', 'コンサルティング開始前の現状・課題・資料を回収します。', [
    ['company', 'short_text', '会社名', true], ['issue', 'long_text', '現在の課題', true, { tags: ['objective'] }],
    ['goal', 'long_text', '期待する成果', true, { tags: ['objective'] }], ['kpi_current', 'long_text', '現在の主要数値（任意）'],
  ], [['consult_docs', '現状資料（事業計画・数値資料等）', 1, DOCS, 'finance']]),
  simple('tax', '税務・会計資料の回収', 'accounting', 'accounting_prep', '確定申告・決算準備に必要な資料を回収します。必要書類の網羅性・法的要件は保証しません。', [
    ['client_name', 'short_text', '氏名・法人名', true], ['fiscal_year', 'short_text', '対象年度', true],
    ['has_employees', 'yes_no', '従業員はいますか？', true],
  ], [['bank_statements', '通帳・口座明細', 1, ['pdf', 'csv', 'jpg', 'png'], 'finance'], ['receipts', '領収書・請求書', 1, ['pdf', 'jpg', 'png', 'heic'], 'finance']]),
  simple('realestate', '不動産（物件情報・必要書類）', 'realestate', 'generic', '物件掲載・取引準備に必要な情報と資料を回収します。法的必要書類は保証しません。', [
    ['property_name', 'short_text', '物件名', true], ['property_address', 'short_text', '所在地', true],
    ['deal_type', 'single_choice', '取引種別', true, { options: [{ value: 'sell', label: '売却' }, { value: 'rent', label: '賃貸' }] }],
  ], [['property_photos', '物件写真', 5, IMG, 'product'], ['floor_plan', '間取り図', 1, ['pdf', 'jpg', 'png'], 'reference']]),
  simple('generic', '汎用ヒアリング', 'generic', 'generic', 'どの業種でも使える基本のヒアリングテンプレートです。', [
    ['client_name', 'short_text', 'お名前・会社名', true], ['email', 'email', 'メールアドレス', true],
    ['purpose', 'long_text', 'ご依頼の目的', true, { tags: ['objective'] }], ['details', 'long_text', 'ご要望の詳細'],
  ], [['generic_files', '関連資料', 1, [...DOCS, ...IMG], 'other']]),
]
