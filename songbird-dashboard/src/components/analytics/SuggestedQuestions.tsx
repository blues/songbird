import { Lightbulb, TrendingUp, AlertTriangle, MapPin, Zap, ThermometerSun } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface SuggestedQuestionsProps {
  onSelect: (question: string) => void;
}

const SUGGESTED_QUESTIONS = [
  {
    icon: MapPin,
    question: 'Give me the last ten unique locations where my devices have reported a location',
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
  },
  {
    icon: TrendingUp,
    question: 'Do you see any out of variance telemetry readings in the last 30 days?',
    color: 'text-orange-500',
    bgColor: 'bg-orange-500/10',
  },
  {
    icon: Zap,
    question: 'Show me a graph of power usage across all of the journeys for my devices',
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-500/10',
  },
  {
    icon: ThermometerSun,
    question: 'Show me all devices and highlight the highest and lowest temperature readings over the last month',
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
  },
  {
    icon: AlertTriangle,
    question: 'What devices have alerted the most in the last month?',
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10',
  },
  {
    icon: TrendingUp,
    question: 'Show me temperature trends for all my devices over the last 7 days',
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
  },
];

export function SuggestedQuestions({ onSelect }: SuggestedQuestionsProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Lightbulb className="h-5 w-5 text-yellow-500" />
        <h3 className="text-lg font-semibold">Suggested Questions</h3>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {SUGGESTED_QUESTIONS.map((item, index) => {
          const Icon = item.icon;
          return (
            <Card
              key={index}
              className="p-4 cursor-pointer hover:shadow-lg transition-shadow"
              onClick={() => onSelect(item.question)}
            >
              <div className="flex items-start gap-3">
                <div className={`flex-shrink-0 w-10 h-10 rounded-lg ${item.bgColor} flex items-center justify-center`}>
                  <Icon className={`h-5 w-5 ${item.color}`} />
                </div>
                <p className="text-sm flex-1">{item.question}</p>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
